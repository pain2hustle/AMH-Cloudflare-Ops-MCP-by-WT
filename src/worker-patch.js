// worker_patch (2026-10-21, Austin + dot's brief): land an exact code patch on an allow-listed Worker straight through
// the Cloudflare API, no GitHub runner and no AI in the deploy step.
//   worker_patch_grant  -> a short-lived, single-use grant bound to caller, script, operation, request id and patch hash
//   worker_patch        -> verifies the grant, claims it ONCE (Durable Object = atomic), checks live == latest == repo,
//                          uploads a version, checks it on its preview URL, sends 100% traffic, checks live, rolls back
//                          on failure, syncs the repo file ([skip ci]) and keeps a receipt
//   worker_patch_status -> the receipt for a request id (needs a key like every hub call)
var WP_SCRIPTS = {
  "amh-site-revival-proxy": { account: "0ebf6d65d7a9ddccd41cba0b8bd1414c", subdomain: "pain2hustle1", repo: "pain2hustle1/Amhsitereviver", path: "workers/amh-site-proxy/index.js",
    live: "https://www.amhsiterevival.com", previewChecks: [["/", "<title"], ["/insights", "<title"], ["/fieldscan/", "<title"], ["/api/te?op=quotes&syms=SPY", '"price"']],
    liveChecks: [["/", "<title"], ["/tradingexpert", "<title"], ["/api/public-config", "{"], ["/api/te?op=quotes&syms=SPY", '"price"']] },
  "wp-test": { account: "0ebf6d65d7a9ddccd41cba0b8bd1414c", subdomain: "pain2hustle1", repo: null, path: null,
    live: "https://wp-test.pain2hustle1.workers.dev", previewChecks: [["/", "wp-test"]], liveChecks: [["/", "wp-test"]] },
};
var WP_GRANT_TTL = 600;
var WP_TOOL_DEFS = [
  { name: "worker_patch_grant", description: "Step 1 of landing server code on an allow-listed Worker (" + Object.keys(WP_SCRIPTS).join(", ") + "): get a single-use grant for this exact patch (expires in 10 min). Same script/edits/request_id go to worker_patch.",
    inputSchema: { type: "object", properties: { script: { type: "string" }, request_id: { type: "string", description: "unique, a-z0-9-, 8-80" }, edits: { type: "array", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" }, count: { type: "number" } }, required: ["find", "replace"] } } }, required: ["script", "request_id", "edits"] } },
  { name: "worker_patch", description: "Step 2: land the patch. dry_run:true shows what would change and uses nothing. Live code must equal the latest version and the repo file, or it refuses. Checks the new version on its preview URL, goes live, checks live, rolls back by itself on failure, syncs the repo. Same request_id again returns the first receipt.",
    inputSchema: { type: "object", properties: { grant: { type: "string" }, script: { type: "string" }, request_id: { type: "string" }, edits: { type: "array", items: { type: "object" } }, base_version: { type: "string", description: "optional: the live version you read; refuses if it changed" }, dry_run: { type: "boolean" } }, required: ["grant", "script", "request_id", "edits"] } },
  { name: "worker_patch_sync", description: "Owner: put the repo's main file for an allow-listed Worker live exactly as written (preview check, live check, rollback). Needed once, or after someone deployed another way. dry_run defaults to true.",
    inputSchema: { type: "object", properties: { script: { type: "string" }, dry_run: { type: "boolean" } }, required: ["script"] } },
  { name: "worker_patch_status", description: "Receipt for a worker_patch request id (state, versions, checks, rollback, repo commit).",
    inputSchema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] } },
];
var WP_TOOLS = new Set(WP_TOOL_DEFS.map((t) => t.name));
var wpEnc = new TextEncoder();
var wpB64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
var wpUnb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function wpSha(text) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", wpEnc.encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function wpKey(env) {
  if (!env.MCP_ACCESS_KEY) throw new Error("hub has no signing secret");
  const base = await crypto.subtle.importKey("raw", wpEnc.encode(env.MCP_ACCESS_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, wpEnc.encode("worker-patch-grant-v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function wpNorm(args) {
  const script = String(args.script || "").trim(), rid = String(args.request_id || "").trim();
  if (!WP_SCRIPTS[script]) throw new Error("script not allowed; allowed: " + Object.keys(WP_SCRIPTS).join(", "));
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/.test(rid)) throw new Error("request_id must be a-z0-9-, 8-80 chars");
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (!edits.length || edits.length > 20) throw new Error("1-20 edits");
  const clean = edits.map((e) => {
    if (!e || typeof e.find !== "string" || !e.find || typeof e.replace !== "string") throw new Error("each edit needs find + replace text");
    return { find: e.find, replace: e.replace, count: Number(e.count) || 1 };
  });
  return { script, rid, edits: clean };
}
var wpPatchSha = (n) => wpSha(JSON.stringify({ script: n.script, edits: n.edits.map((e) => [e.find, e.replace, e.count]) }));
async function wpLedger(env, body) {
  const stub = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName("worker-patch-ledger"));
  const r = await stub.fetch("https://ledger/worker-patch", { method: "POST", body: JSON.stringify(body) });
  return r.json();
}
// Runs inside the Durable Object: one request at a time, so a grant can only be claimed once.
async function wpLedgerFetch(request, state) {
  const b = await request.json(), st = state.storage;
  if (b.action === "claim") {
    const old = await st.get("rid:" + b.rid);
    if (old) return Response.json(old.sha === b.sha ? { existing: old } : { error: "request_id was already used for a different patch" });
    if (await st.get("jti:" + b.jti)) return Response.json({ error: "grant already used" });
    const lock = await st.get("lock:" + b.script);
    if (lock && Date.now() - lock.at < 10 * 60e3) return Response.json({ error: "another patch is landing on " + b.script + " (" + lock.rid + "), try again in a few minutes" });
    const rec = { request_id: b.rid, script: b.script, sha: b.sha, actor: b.actor, state: "accepted", accepted_at: new Date().toISOString() };
    await st.put("jti:" + b.jti, { rid: b.rid, at: Date.now() });
    await st.put("rid:" + b.rid, rec);
    await st.put("lock:" + b.script, { rid: b.rid, at: Date.now() });
    return Response.json({ claimed: rec });
  }
  if (b.action === "update") {
    const rec = { ...(await st.get("rid:" + b.rid) || {}), ...b.patch };
    await st.put("rid:" + b.rid, rec);
    if (b.release) await st.delete("lock:" + rec.script);
    return Response.json({ ok: true });
  }
  if (b.action === "get") return Response.json({ record: await st.get("rid:" + b.rid) || null });
  return Response.json({ error: "bad action" }, { status: 400 });
}
async function wpGrant(env, args, actor) {
  const n = wpNorm(args), sha = await wpPatchSha(n), now = Math.floor(Date.now() / 1e3);
  const ttl = Math.min(Math.max(Number(args.ttl_seconds) || WP_GRANT_TTL, 5), WP_GRANT_TTL);
  const claims = { v: 1, aud: "worker_patch", op: "deploy", sub: String(actor || "admin"), script: n.script, rid: n.rid, sha, jti: crypto.randomUUID(), iat: now, exp: now + ttl };
  const body = wpB64u(wpEnc.encode(JSON.stringify(claims)));
  const sig = wpB64u(await crypto.subtle.sign("HMAC", await wpKey(env), wpEnc.encode(body)));
  return { grant: body + "." + sig, patch_sha256: sha, request_id: n.rid, script: n.script, expires_at: new Date(claims.exp * 1e3).toISOString(), next: "call worker_patch with this grant and the SAME script, request_id and edits" };
}
async function wpVerify(env, grant, n, sha, actor) {
  const [body, sig] = String(grant || "").split(".");
  if (!body || !sig) throw new Error("grant missing or malformed");
  if (!await crypto.subtle.verify("HMAC", await wpKey(env), wpUnb64u(sig), wpEnc.encode(body))) throw new Error("grant signature invalid");
  const c = JSON.parse(new TextDecoder().decode(wpUnb64u(body)));
  if (c.v !== 1 || c.aud !== "worker_patch" || c.op !== "deploy") throw new Error("grant is not for worker_patch");
  if (c.exp < Math.floor(Date.now() / 1e3)) throw new Error("grant expired");
  if (c.sub !== String(actor || "admin")) throw new Error("grant belongs to a different caller");
  if (c.script !== n.script) throw new Error("grant is for a different script");
  if (c.rid !== n.rid) throw new Error("grant is for a different request_id");
  if (c.sha !== sha) throw new Error("patch differs from the one the grant was issued for");
  return c;
}
async function wpCf(env, acct, path, init = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/workers/scripts/${path}`, { ...init, headers: { authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN, ...(init.headers || {}) } });
  return r;
}
async function wpCfJson(env, acct, path, init) {
  const r = await wpCf(env, acct, path, init), j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`Cloudflare ${path.split("?")[0]}: ${r.status} ${(j.errors || []).map((e) => e.message).join("; ").slice(0, 200)}`);
  return j.result;
}
async function wpChecks(base, checks) {
  const out = [];
  for (const [p, want] of checks) {
    let code = 0, ok = false;
    try { const r = await fetch(base + p, { headers: { "user-agent": "Mozilla/5.0 (amh-worker-patch-check)" }, redirect: "manual" }); code = r.status; ok = code === 200 && (await r.text()).toLowerCase().includes(want.toLowerCase()); } catch {}
    out.push({ path: p, status: code, ok });
  }
  return { ok: out.every((c) => c.ok), checks: out };
}
async function wpLiveState(env, s, name) {
  const dep = await wpCfJson(env, s.account, name + "/deployments");
  const cur = (dep.deployments || [])[0];
  if (!cur || cur.versions.length !== 1 || cur.versions[0].percentage !== 100) throw new Error("live traffic is split across versions; finish that first");
  const active = cur.versions[0].version_id;
  // The code of the version that is actually serving (uploads that never went live don't matter).
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${s.account}/workers/workers/${name}/versions/${active}?include=modules`, { headers: { authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error("could not read the live version's code: " + r.status);
  const mods = j.result.modules || [], main = j.result.main_module || (mods[0] && mods[0].name);
  if (mods.length !== 1 || !main) throw new Error("live version has " + mods.length + " modules; only single-file Workers are supported");
  const code = new TextDecoder().decode(Uint8Array.from(atob(mods[0].content_base64), (c) => c.charCodeAt(0)));
  return { active, code: code.replace(/\r\n/g, "\n"), mainName: main };
}
function wpApply(code, edits) {
  let out = code;
  for (const e of edits) {
    const n = out.split(e.find).length - 1;
    if (n !== e.count) throw new Error(`find occurs ${n} time(s), expected ${e.count}: ${e.find.slice(0, 80)}`);
    out = out.split(e.find).join(e.replace);
  }
  if (out === code) throw new Error("patch changes nothing");
  if (out.length > 9e5) throw new Error("result too large");
  return out;
}
async function wpRun(env, args, actor) {
  const n = wpNorm(args), s = WP_SCRIPTS[n.script], sha = await wpPatchSha(n);
  const claims = await wpVerify(env, args.grant, n, sha, actor);
  // A repeat of a request that was already accepted gets its receipt back, even after the code changed.
  const seen = (await wpLedger(env, { action: "get", rid: n.rid })).record;
  if (seen) return seen.sha === sha ? { already_handled: true, receipt: seen } : { error: "request_id was already used for a different patch" };
  const live = await wpLiveState(env, s, n.script);
  if (args.base_version && !live.active.startsWith(String(args.base_version))) throw new Error("live version is " + live.active + ", not the base_version you read");
  let repoFile = null;
  if (s.repo) {
    const meta = await gh(env, "GET", `/repos/${s.repo}/contents/${s.path}?ref=main`);
    repoFile = { sha: meta.sha, text: new TextDecoder().decode(await gh(env, "GET", `/repos/${s.repo}/contents/${s.path}?ref=main`, null, "application/vnd.github.raw")).replace(/\r\n/g, "\n") };
    if (repoFile.text.trim() !== live.code.trim()) throw new Error(`live code differs from ${s.repo}/${s.path} on main (someone deployed another way, or the repo moved on). The owner runs worker_patch_sync once, then patch again.`);
  }
  const next = wpApply(live.code, n.edits);
  if (args.dry_run === true) return { dry_run: true, script: n.script, request_id: n.rid, patch_sha256: sha, live_version: live.active, bytes_before: live.code.length, bytes_after: next.length, edits: n.edits.length, grant_used: false, next: "call again without dry_run (same grant) to land it" };
  const claim = await wpLedger(env, { action: "claim", rid: n.rid, jti: claims.jti, sha, script: n.script, actor: String(actor || "admin") });
  if (claim.error) throw new Error(claim.error);
  if (claim.existing) return { already_handled: true, receipt: claim.existing };
  return wpShip(env, s, n.script, n.rid, live, next, { base_version: live.active, patch_sha256: sha }, repoFile);
}
async function wpShip(env, s, script, rid, live, next, base, repoFile) {
  const n = { script, rid };
  const upd = (patch, release) => wpLedger(env, { action: "update", rid, patch, release });
  const rec = { ...base, state: "uploading" };
  await upd(rec);
  try {
    const settings = await wpCfJson(env, s.account, n.script + "/settings");
    const keep = [...new Set((settings.bindings || []).map((b) => b.type))];
    const msg = "worker_patch " + n.rid;
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ main_module: live.mainName, compatibility_date: settings.compatibility_date, compatibility_flags: settings.compatibility_flags || [], bindings: [], keep_bindings: keep, annotations: { "workers/message": msg, "workers/tag": n.rid.slice(0, 50) } })], { type: "application/json" }));
    form.append(live.mainName, new Blob([next], { type: "application/javascript+module" }), live.mainName);
    const ver = await wpCfJson(env, s.account, n.script + "/versions", { method: "POST", body: form });
    rec.new_version = ver.id;
    const preview = `https://${ver.id.slice(0, 8)}-${n.script}.${s.subdomain}.workers.dev`;
    rec.preview = await wpChecks(preview, s.previewChecks);
    if (!rec.preview.ok) { Object.assign(rec, { state: "refused_preview_failed", finished_at: new Date().toISOString(), live_changed: false }); await upd(rec, true); return rec; }
    const dep = await wpCfJson(env, s.account, n.script + "/deployments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ strategy: "percentage", versions: [{ version_id: ver.id, percentage: 100 }], annotations: { "workers/message": msg } }) });
    rec.deployment_id = dep.id; rec.rollback_to = live.active; rec.state = "live_checking";
    await upd(rec);
    await new Promise((r) => setTimeout(r, 3e3));
    rec.live = await wpChecks(s.live, s.liveChecks);
    if (!rec.live.ok) {
      const back = await wpCfJson(env, s.account, n.script + "/deployments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ strategy: "percentage", versions: [{ version_id: live.active, percentage: 100 }], annotations: { "workers/message": "worker_patch rollback " + n.rid } }) });
      Object.assign(rec, { state: "rolled_back_live_check_failed", rollback_deployment_id: back.id, finished_at: new Date().toISOString() });
      await upd(rec, true); return rec;
    }
    rec.state = "live";
    if (s.repo && repoFile) {
      try {
        const c = await gh(env, "PUT", `/repos/${s.repo}/contents/${s.path}`, { message: `worker_patch ${n.rid}: synced from live version ${ver.id.slice(0, 8)} [skip ci]`, content: btoa(String.fromCharCode(...wpEnc.encode(next))), sha: repoFile.sha, branch: "main" });
        rec.repo_commit = c.commit && c.commit.sha;
      } catch (e) { rec.repo_sync_error = String(e.message || e).slice(0, 200); rec.state = "live_repo_not_synced"; }
    }
    rec.finished_at = new Date().toISOString();
    await upd(rec, true);
    return rec;
  } catch (e) {
    Object.assign(rec, { state: rec.deployment_id ? "error_after_deploy_check_live" : "error_nothing_live", error: String(e.message || e).slice(0, 300), finished_at: new Date().toISOString() });
    await upd(rec, true);
    return rec;
  }
}
// One-time (or after a deploy made another way): put the repo's main file live verbatim, same checks + rollback.
async function wpSync(env, args, actor) {
  const script = String(args.script || ""), s = WP_SCRIPTS[script];
  if (!s || !s.repo) throw new Error("script not allowed or has no repo");
  const meta = await gh(env, "GET", `/repos/${s.repo}/contents/${s.path}?ref=main`);
  const text = new TextDecoder().decode(await gh(env, "GET", `/repos/${s.repo}/contents/${s.path}?ref=main`, null, "application/vnd.github.raw")).replace(/\r\n/g, "\n");
  const live = await wpLiveState(env, s, script);
  if (live.code.trim() === text.trim()) return { in_sync: true, live_version: live.active };
  const sha = await wpSha(text), rid = "sync-" + sha.slice(0, 12) + "-" + live.active.slice(0, 8);
  if (args.dry_run !== false) return { dry_run: true, script, live_version: live.active, repo_file_sha: meta.sha, bytes_live: live.code.length, bytes_repo: text.length, next: "call again with dry_run:false to put the repo file live" };
  const claim = await wpLedger(env, { action: "claim", rid, jti: "sync-" + crypto.randomUUID(), sha, script, actor: String(actor || "admin") });
  if (claim.error) throw new Error(claim.error);
  if (claim.existing) return { already_handled: true, receipt: claim.existing };
  return wpShip(env, s, script, rid, live, text, { base_version: live.active, repo_file_sha: meta.sha, kind: "sync" }, null);
}
async function runWorkerPatchTool(name, args, env, actor) {
  try {
    if (name === "worker_patch_sync") return await wpSync(env, args, actor);
    if (name === "worker_patch_grant") return await wpGrant(env, args, actor);
    if (name === "worker_patch") return await wpRun(env, args, actor);
    if (name === "worker_patch_status") {
      const rid = String(args.request_id || "");
      if (!/^[a-z0-9][a-z0-9-]{7,79}$/.test(rid)) throw new Error("bad request_id");
      const r = await wpLedger(env, { action: "get", rid });
      return r.record ? { receipt: r.record } : { receipt: null, note: "no such request (never claimed)" };
    }
  } catch (e) { return { error: String(e && e.message || e).slice(0, 400) }; }
}
