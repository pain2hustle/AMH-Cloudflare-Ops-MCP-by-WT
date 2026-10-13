// wt-users.js — Walrus Tusk self-serve users: anyone gets a key at /join, adds THEIR OWN Cloudflare
// (and optional GitHub) token at /setup, then their AI (Grok, Claude, ChatGPT…) can read, patch and deploy
// THEIR sites and commit to THEIR repos from a phone. Nothing here can reach the owner's accounts:
//   - user keys are `wtu_…`, stored only as a SHA-256 hash (KV wtuser:<hash>)
//   - their tokens are AES-GCM encrypted with the hub secret WT_USER_SECRET (KV wtcreds:<id>)
//   - every Cloudflare call uses their token and is limited to the accounts that token can see
//   - every GitHub call uses their token and is limited to their login + orgs
//   - the tool list for user keys is a fixed allowlist (no federation, no owner/admin tools)

var WTU_PREFIX = "wtu_";
var WTU_PAGES_TOOLS = ["pages_list_deployments", "pages_get_deployment", "pages_read_file", "pages_patch", "pages_deploy", "pages_rollback", "pages_special_files"];
var WTU_REPO_TOOLS = ["repo_list", "repo_read", "repo_search", "repo_commit_push", "repo_open_pr", "repo_merge_pr"];
var WTU_JOIN_PER_HOUR = 5;

function wtuB64(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function wtuUnb64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
async function wtuSha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
function wtuRandom(n) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const r = crypto.getRandomValues(new Uint8Array(n));
  return [...r].map((x) => abc[x % abc.length]).join("");
}
async function wtuCryptoKey(env) {
  if (!env.WT_USER_SECRET) throw new Error("hub is missing WT_USER_SECRET");
  return crypto.subtle.importKey("raw", wtuUnb64(env.WT_USER_SECRET), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function wtuEncrypt(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wtuCryptoKey(env), new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: wtuB64(iv), ct: wtuB64(new Uint8Array(ct)) };
}
async function wtuDecrypt(env, rec) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: wtuUnb64(rec.iv) }, await wtuCryptoKey(env), wtuUnb64(rec.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

async function wtuAuthorize(env, provided) {
  if (!env.CLOUDFLARE_OPS_OAUTH) return { ok: false, reason: "storage_unavailable" };
  const keyHash = await wtuSha(provided);
  const user = await env.CLOUDFLARE_OPS_OAUTH.get(`wtuser:${keyHash}`, "json");
  if (!user || user.disabled) return { ok: false, reason: "invalid_user_key" };
  return { ok: true, mode: "user", userId: user.id, keyHash };
}
async function wtuCreds(env, userId) {
  const rec = await env.CLOUDFLARE_OPS_OAUTH.get(`wtcreds:${userId}`, "json");
  return rec ? await wtuDecrypt(env, rec) : null;
}

// ---------- verifying what a user pastes ----------
async function wtuCheckCloudflare(token) {
  const call = async (p) => { const r = await fetch(`https://api.cloudflare.com/client/v4${p}`, { headers: { authorization: `Bearer ${token}` } }); return r.json().catch(() => ({})); };
  const acc = await call("/accounts?per_page=50");
  if (!acc.success || !(acc.result || []).length) return { ok: false, error: "Cloudflare didn't accept that token, or it can't see any account. Make sure it has Account → Cloudflare Pages → Edit." };
  const accounts = [];
  for (const a of acc.result) {
    const names = [];
    let pagesOk = false;
    for (let page = 1; page <= 10; page++) {
      const p = await call(`/accounts/${a.id}/pages/projects?per_page=10&page=${page}`);
      if (!p.success) break;
      pagesOk = true;
      names.push(...(p.result || []).map((x) => x.name));
      if ((p.result || []).length < 10) break;
    }
    accounts.push({ id: a.id, name: a.name, pages: pagesOk, projects: names });
  }
  if (!accounts.some((a) => a.pages)) return { ok: false, error: "The token works but has no Pages permission. Edit it and add Account → Cloudflare Pages → Edit." };
  return { ok: true, accounts };
}
async function wtuCheckGithub(token) {
  const h = { authorization: `Bearer ${token}`, "user-agent": "walrus-tusk-hub", accept: "application/vnd.github+json" };
  const u = await fetch("https://api.github.com/user", { headers: h });
  if (!u.ok) return { ok: false, error: "GitHub didn't accept that token." };
  const me = await u.json();
  const o = await fetch("https://api.github.com/user/orgs?per_page=100", { headers: h });
  const orgs = o.ok ? (await o.json()).map((x) => x.login) : [];
  return { ok: true, login: me.login, owners: [me.login, ...orgs] };
}

// ---------- HTTP: /join and /setup ----------
function wtuJson(obj, status = 200) { return new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } }); }
async function wtuBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await request.json().catch(() => ({}));
  const f = await request.formData().catch(() => null);
  return f ? Object.fromEntries(f) : {};
}
async function wtuHandleHttp(request, env, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p !== "/join" && p !== "/setup") return null;
  if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } });
  if (request.method === "GET") return new Response(wtuPage(p, url.origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const kv = env.CLOUDFLARE_OPS_OAUTH;
  const body = await wtuBody(request);

  if (p === "/join") {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const hourKey = `wtjoin:${await wtuSha(ip)}:${new Date().toISOString().slice(0, 13)}`;
    const n = Number(await kv.get(hourKey)) || 0;
    if (n >= WTU_JOIN_PER_HOUR) return wtuJson({ error: "too many new keys from this network this hour; try again later" }, 429);
    await kv.put(hourKey, String(n + 1), { expirationTtl: 7200 });
    const key = WTU_PREFIX + wtuRandom(40);
    const id = "u_" + wtuRandom(16);
    await kv.put(`wtuser:${await wtuSha(key)}`, JSON.stringify({ id, created: new Date().toISOString(), label: String(body.label || "").slice(0, 60) }));
    return wtuJson({ ok: true, key, mcp_url: `${url.origin}/mcp?key=${key}`, setup_url: `${url.origin}/setup`, note: "Save this key now — it is shown once. Next: add your Cloudflare token at /setup." });
  }

  // /setup
  const key = String(body.key || "").trim();
  const auth = key.startsWith(WTU_PREFIX) ? await wtuAuthorize(env, key) : { ok: false };
  if (!auth.ok) return wtuJson({ error: "unknown key — get one at /join" }, 401);
  const creds = (await wtuCreds(env, auth.userId)) || {};
  if (body.delete === true || body.delete === "true") {
    await kv.delete(`wtcreds:${auth.userId}`);
    return wtuJson({ ok: true, deleted: true, note: "Your saved tokens are gone from the hub. Also revoke them in Cloudflare/GitHub." });
  }
  const out = { ok: true };
  const cfTok = String(body.cloudflare_token || "").trim();
  const ghTok = String(body.github_token || "").trim();
  if (!cfTok && !ghTok && !creds.cf_token) return wtuJson({ error: "paste a Cloudflare API token" }, 400);
  if (cfTok) {
    const c = await wtuCheckCloudflare(cfTok);
    if (!c.ok) return wtuJson({ error: c.error }, 400);
    creds.cf_token = cfTok;
    creds.cf_accounts = c.accounts.map((a) => ({ id: a.id, name: a.name, pages: a.pages }));
    out.cloudflare = c.accounts.map((a) => ({ account: a.name, pages_access: a.pages, sites: a.projects }));
  }
  if (ghTok) {
    const g = await wtuCheckGithub(ghTok);
    if (!g.ok) return wtuJson({ error: g.error }, 400);
    creds.gh_token = ghTok;
    creds.gh_login = g.login;
    creds.gh_owners = g.owners;
    out.github = { login: g.login, owners: g.owners };
  }
  creds.updated = new Date().toISOString();
  await kv.put(`wtcreds:${auth.userId}`, JSON.stringify(await wtuEncrypt(env, creds)));
  out.next = `Add this to your AI app as an MCP connector: ${url.origin}/mcp?key=<your key>. Then ask it to "list my sites".`;
  return wtuJson(out);
}

// ---------- MCP: tool list + calls for user keys ----------
var WTU_EXTRA_DEFS = [
  { name: "my_sites", description: "List the Cloudflare Pages sites your token can see (all your accounts): project, production branch, domains, last deploy. Start here.", inputSchema: { type: "object", properties: {} } },
  { name: "wt_whoami", description: "Show what this Walrus Tusk key is connected to (Cloudflare accounts, GitHub login). Tokens are never shown.", inputSchema: { type: "object", properties: {} } },
];
function wtuToolDefs() {
  const all = [...TOOLS, ...GITHUB_TOOL_DEFS];
  const pick = (n) => all.find((t) => t.name === n);
  const fix = (t) => {
    const c = JSON.parse(JSON.stringify(t));
    if (c.inputSchema && c.inputSchema.properties && c.inputSchema.properties.account) {
      c.inputSchema.properties.account = { type: "string", description: "your Cloudflare account id or name (default: your first account)" };
      c.inputSchema.required = (c.inputSchema.required || []).filter((r) => r !== "account");
    }
    if (c.inputSchema && c.inputSchema.properties && c.inputSchema.properties.repo) c.inputSchema.properties.repo = { type: "string", description: "owner/name (your login or one of your orgs), or just name" };
    c.description = c.description.replace(/pain2hustle1?\/\*?(<name>)?/g, "your").replace(/Austin(['’]s)?/g, "your").replace(/amh \(pain2hustle1\) or doors \(austinsdoors1\)/g, "your account");
    return c;
  };
  return [...WTU_EXTRA_DEFS, ...WTU_PAGES_TOOLS.map(pick), ...WTU_REPO_TOOLS.map(pick), ...AUTODEPLOY_TOOL_DEFS].filter(Boolean).map(fix);
}
function wtuAccount(creds, wanted) {
  const list = creds.cf_accounts || [];
  if (!wanted) return (list.find((a) => a.pages) || list[0] || {}).id;
  const w = String(wanted).trim().toLowerCase();
  const hit = list.find((a) => a.id === w || String(a.name || "").toLowerCase() === w);
  if (!hit) throw new Error(`that account isn't on your token. Yours: ${list.map((a) => a.name).join(", ")}`);
  return hit.id;
}
async function wtuCallTool(name, args, env, authContext, origin) {
  try {
    const creds = await wtuCreds(env, authContext.userId);
    const setup = `${origin || "https://mcp.artificialmindhive.com"}/setup`;
    if (name === "wt_whoami") return { cloudflare_accounts: (creds && creds.cf_accounts || []).map((a) => ({ name: a.name, id: a.id, pages: a.pages })), github: creds && creds.gh_login || null, setup_page: setup };
    if (!creds || !creds.cf_token) return { error: `this key has no Cloudflare token yet. Add one at ${setup}` };
    if (name === "my_sites") {
      const client = new CloudflareClient({ token: creds.cf_token });
      const out = [];
      for (const a of creds.cf_accounts.filter((x) => x.pages)) {
        for (let page = 1; page <= 10; page++) {
        const { result } = await client.request("GET", `/accounts/${a.id}/pages/projects?per_page=10&page=${page}`);
        for (const pr of result || []) out.push({ account: a.name, project: pr.name, production_branch: pr.production_branch, domains: pr.domains, last_deploy: pr.canonical_deployment && pr.canonical_deployment.created_on });
        if (!result || result.length < 10) break;
        }
      }
      return { sites: out, tip: "Read a page with pages_read_file, change it with pages_patch (dry-run first, then apply:true)." };
    }
    if (name === "pages_deploy" && (args.patch === true || Array.isArray(args.edits))) name = "pages_patch";
    if (name === "pages_get_deployment" && args.path) name = "pages_read_file";
    if (WTU_PAGES_TOOLS.includes(name) || name === "pages_read_file") {
      const a = { ...args, account: wtuAccount(creds, args.account) };
      const client = new CloudflareClient({ token: creds.cf_token });
      if (name === "pages_patch") return await pagesPatch(client, a, env, `wtu:${authContext.userId}`);
      if (name === "pages_read_file") return await pagesReadFile(client, a);
      if (name === "pages_special_files") return await pagesSaveSpecial(client, a, env);
      return await runPagesDeployTool(name, a, client, null);
    }
    if (WTU_REPO_TOOLS.includes(name)) {
      if (!creds.gh_token) return { error: `this key has no GitHub token yet. Add one at ${setup}` };
      const env2 = { ...env, GITHUB_TOKEN: creds.gh_token, GH_OWNERS_OVERRIDE: creds.gh_owners || [creds.gh_login] };
      return await runGithubTool(name, args, env2, `wtu:${authContext.userId}`);
    }
    if (name === "site_autodeploy" || name === "site_autodeploy_status") {
      if (!creds.gh_token) return { error: `site_autodeploy needs a GitHub token too. Add one at ${setup}` };
      const env2 = { ...env, GITHUB_TOKEN: creds.gh_token, GH_OWNERS_OVERRIDE: creds.gh_owners || [creds.gh_login] };
      if (name === "site_autodeploy_status") return await siteAutodeployStatus(env2, args);
      return await siteAutodeploy(new CloudflareClient({ token: creds.cf_token }), creds.cf_token, wtuAccount(creds, args.account), env2, args);
    }
    return { error: `${name} isn't available on user keys` };
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 600) }; }
}

// ---------- pages ----------
function wtuPage(p, origin) {
  const css = `:root{--bg:#07080b;--card:#11131a;--line:#262a36;--gold:#e8b64c;--gold2:#ffd27a;--ink:#f3f1ea;--mut:#9aa0ad;--bad:#ff6b6b;--ok:#5fd38d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:28px 16px 60px}h1{font-size:28px;margin:0 0 4px;letter-spacing:-.02em}h1 b{color:var(--gold)}
.sub{color:var(--mut);margin:0 0 22px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin:14px 0}
h2{font-size:15px;margin:0 0 10px;color:var(--gold2);text-transform:uppercase;letter-spacing:.08em}ol{padding-left:20px;margin:6px 0}li{margin:4px 0}
label{display:block;font-size:13px;color:var(--mut);margin:12px 0 4px}input{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#0b0d12;color:var(--ink);font:14px ui-monospace,Consolas,monospace}
button{width:100%;margin-top:16px;padding:14px;border:0;border-radius:12px;background:linear-gradient(180deg,var(--gold2),var(--gold));color:#1a1405;font-weight:700;font-size:16px}
code,.mono{font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-all}.out{white-space:pre-wrap;margin-top:12px;font-size:13px}.bad{color:var(--bad)}.ok{color:var(--ok)}a{color:var(--gold2)}
.key{background:#0b0d12;border:1px dashed var(--gold);border-radius:10px;padding:12px;margin:8px 0}`;
  const head = (t) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t} — Walrus Tusk</title><style>${css}</style></head><body><main>`;
  if (p === "/join") return head("Get your key") + `
<h1>Walrus <b>Tusk</b></h1><p class="sub">Let your AI edit and deploy your Cloudflare sites from your phone.</p>
<div class="card"><h2>1 · Get your key</h2><p>One tap. No account, no email.</p><button id="go">Get my key</button><div id="res" class="out"></div></div>
<div class="card"><h2>How it works</h2><ol><li>Get a key here.</li><li>Add your Cloudflare token on the <a href="${origin}/setup">setup page</a> (and GitHub, optional).</li><li>Add the MCP link to Grok, Claude or ChatGPT.</li><li>Say “list my sites”, then “change … on my homepage”. It reads the live page, shows a dry run, and deploys only the changed file.</li></ol></div>
<script>document.getElementById('go').onclick=async()=>{const b=document.getElementById('go');b.disabled=true;b.textContent='…';const r=await fetch('/join',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const j=await r.json();const o=document.getElementById('res');
if(!r.ok){o.innerHTML='<span class=bad>'+(j.error||'failed')+'</span>';b.disabled=false;b.textContent='Get my key';return}
b.style.display='none';o.innerHTML='<b class=ok>Your key (save it now, shown once):</b><div class="key mono">'+j.key+'</div><b>MCP link for your AI app:</b><div class="key mono">'+j.mcp_url+'</div><a href="/setup#'+j.key+'">Next: add your Cloudflare token →</a>';try{localStorage.setItem('wtu',j.key)}catch(e){}}</script></main></body></html>`;
  return head("Setup") + `
<h1>Walrus <b>Tusk</b> setup</h1><p class="sub">Your tokens are encrypted and only ever used for your own accounts. You can delete them any time.</p>
<div class="card"><h2>Cloudflare token</h2><ol><li>Open <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">Cloudflare → API Tokens</a> → <b>Create Token</b> → <b>Custom token</b>.</li><li>Permissions: <b>Account → Cloudflare Pages → Edit</b>. Optional: <b>Zone → Analytics → Read</b>.</li><li>Account resources: your account. Create, then copy the token.</li></ol></div>
<div class="card"><h2>GitHub token (optional)</h2><ol><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank">GitHub → Fine-grained token</a>.</li><li>Repository access: the repos you want your AI to edit.</li><li>Permissions: <b>Contents</b>, <b>Pull requests</b> → Read and write. For sites with server code also <b>Secrets</b>, <b>Workflows</b>, <b>Actions</b> → Read and write (used once, by auto-deploy setup).</li></ol><p class="sub" style="margin:8px 0 0">Your AI can then commit to <code>grok/…</code> or <code>agent/…</code> branches and open/merge PRs. It can't force-push, delete branches, or touch <code>.github/</code>.</p></div>
<div class="card"><h2>Save</h2><label>Your Walrus Tusk key</label><input id="k" placeholder="wtu_…" autocomplete="off"><label>Cloudflare API token</label><input id="cf" type="password" autocomplete="off"><label>GitHub token (optional)</label><input id="gh" type="password" autocomplete="off"><button id="save">Check &amp; save</button><div id="res" class="out"></div></div>
<script>const k=document.getElementById('k');k.value=(location.hash.slice(1)||(()=>{try{return localStorage.getItem('wtu')||''}catch(e){return''}})());
document.getElementById('save').onclick=async()=>{const b=document.getElementById('save');b.disabled=true;b.textContent='Checking…';const r=await fetch('/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k.value.trim(),cloudflare_token:document.getElementById('cf').value.trim(),github_token:document.getElementById('gh').value.trim()})});const j=await r.json();const o=document.getElementById('res');b.disabled=false;b.textContent='Check & save';
if(!r.ok){o.innerHTML='<span class=bad>'+(j.error||'failed')+'</span>';return}document.getElementById('cf').value='';document.getElementById('gh').value='';
let h='<b class=ok>Saved.</b>\\n';(j.cloudflare||[]).forEach(a=>h+='Cloudflare: '+a.account+(a.pages_access?' — '+a.sites.length+' site(s): '+a.sites.join(', '):' — no Pages access')+'\\n');if(j.github)h+='GitHub: '+j.github.login+'\\n';h+='\\nAdd to your AI app as an MCP connector:\\n<span class=mono>'+location.origin+'/mcp?key='+k.value.trim()+'</span>\\n\\nThen say: “list my sites”.';o.innerHTML=h}</script></main></body></html>`;
}
