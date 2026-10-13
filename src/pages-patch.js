// pages-patch.js — change a FEW files on a live Pages site without sending the whole site.
// Takes the live production deployment's {path: hash} manifest, swaps in only the files the
// agent sends (or deletes), and creates a new deployment from that. Every other file stays
// byte-identical to what is live. _redirects/_headers are not in Cloudflare's manifest, so the
// hub keeps the last known copy per project in KV (pages:special:<account>:<project>) and
// re-sends it; a patch is refused if it would silently drop them.
// Injected into the live hub bundle by inject-pages-patch.cjs (uses helpers from pages-deploy.js).

var PATCH_MAX_FILES = 200;

async function pagesSpecialGet(env, account, project) {
  if (!env || !env.CLOUDFLARE_OPS_OAUTH) return null;
  return await env.CLOUDFLARE_OPS_OAUTH.get(`pages:special:${account}:${project}`, "json");
}
async function pagesSpecialPut(env, account, project, special) {
  if (!env || !env.CLOUDFLARE_OPS_OAUTH || !special || !Object.keys(special).length) return;
  await env.CLOUDFLARE_OPS_OAUTH.put(`pages:special:${account}:${project}`, JSON.stringify({ ...special, saved: new Date().toISOString() }));
}

// Fetch one file as it is served by a deployment's own URL (no proxy, no custom-domain cache).
// Pages 308s /x.html -> /x, so redirects are followed but must stay on the same page.
async function pagesFetchLiveFile(deployUrl, path) {
  const u = new URL(path, deployUrl);
  const res = await fetch(u.toString(), { redirect: "follow" });
  const landed = new URL(res.url || u.toString()).pathname.replace(/\/$/, "");
  const want = path.replace(/\.html$/, "").replace(/\/index$/, "").replace(/\/$/, "");
  if (res.status !== 200) throw new Error(`${path} returned ${res.status} on the live deployment`);
  if (landed !== want && landed !== path) throw new Error(`${path} redirected to ${landed}; read that path instead`);
  return new Uint8Array(await res.arrayBuffer());
}

// JSON bodies of <script> tags (TradingView-style widget configs, ld+json, inline data).
function pagesJsonBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1].trim();
    if (!/^[\[{]/.test(body)) continue;
    try { JSON.parse(body); out.push({ ok: true }); } catch (e) { out.push({ ok: false, error: String(e.message || e).slice(0, 140) }); }
  }
  return out;
}

// worker.checks: [{path, status, contains?}] — plus worker.expect_title on "/".
async function pagesHealth(deployUrl, worker) {
  const results = [];
  const checks = [...(worker.expect_title ? [{ path: "/", status: 200, contains: `<title>${worker.expect_title}</title>` }] : []), ...(worker.checks || [])];
  for (const c of checks) {
    let got = null;
    for (let i = 0; i < 6; i++) {
      if (i) await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(new URL(c.path, deployUrl).toString(), { redirect: "follow" });
        const body = await res.text();
        got = { path: c.path, status: res.status, ok: res.status === (c.status || 200) && (!c.contains || body.includes(c.contains)) };
      } catch (e) { got = { path: c.path, ok: false, error: String(e.message || e).slice(0, 100) }; }
      if (got.ok) break;
    }
    results.push(got);
  }
  return { ok: results.length > 0 && results.every((x) => x.ok), results };
}

async function pagesReadFile(client, args) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const path = pagesPath(args.path);
  const p = await pagesGetProject(client, account, project);
  const live = p.canonical_deployment;
  if (!live || !live.url) return { error: "no live production deployment" };
  const text = new TextDecoder().decode(await pagesFetchLiveFile(live.url, path));
  const out = { project, path, live_deployment: live.id, bytes: text.length };
  const find = args.find != null ? String(args.find) : "";
  if (find) {
    const around = Math.min(Math.max(Number(args.around) || 300, 0), 4000);
    const hits = [];
    let i = text.indexOf(find);
    while (i !== -1 && hits.length < 10) { hits.push({ at: i, snippet: text.slice(Math.max(0, i - around), i + find.length + around) }); i = text.indexOf(find, i + 1); }
    let n = 0, j = text.indexOf(find); while (j !== -1) { n++; j = text.indexOf(find, j + 1); }
    return { ...out, find, occurrences: n, hits };
  }
  const offset = Math.max(Number(args.offset) || 0, 0), length = Math.min(Math.max(Number(args.length) || 20000, 1), 60000);
  return { ...out, offset, length, more: offset + length < text.length, content: text.slice(offset, offset + length) };
}

async function pagesPatch(client, args, env, actor) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const p = await pagesGetProject(client, account, project);
  const branch = String(args.branch || p.production_branch || "main").trim();
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(branch)) throw new Error("bad branch");
  const production = branch === p.production_branch;
  const live = p.canonical_deployment;
  if (!live || !live.id) return { error: "project has no live production deployment to patch onto" };
  const { result: base } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/deployments/${live.id}`);
  // Sites with server code (_worker / Functions): Cloudflare never returns the deployed worker, so the
  // owner's deploy script stores the exact _worker.bundle wrangler uploaded, tagged with the deployment
  // it went live as. A patch re-attaches it only if live is still that deployment (or one of our patches).
  let worker = null;
  if (base.uses_functions || PAGES_PROTECTED.has(project)) {
    worker = env && env.CLOUDFLARE_OPS_OAUTH ? await env.CLOUDFLARE_OPS_OAUTH.get(`pages:worker:${account}:${project}`, "json") : null;
    if (!worker || !worker.bundle_b64) return { error: `${project} runs server code and the hub has no saved worker bundle for it. The owner's deploy script must store it first.` };
    const known = [worker.for_deployment, ...(worker.deployments || [])];
    if (!known.includes(live.id)) return { error: `${project} live deployment (${live.id.slice(0, 8)}) is not the one the saved worker bundle belongs to (${String(worker.for_deployment).slice(0, 8)}). Someone deployed outside the hub; the owner must refresh it (npm run deploy in amh-hive). Nothing deployed.` };
  }
  const manifest = { ...(base.files || {}) };
  if (!Object.keys(manifest).length) return { error: "Cloudflare returned an empty file list for the live deployment; refusing to patch" };

  const files = Array.isArray(args.files) ? args.files.slice() : [];
  const editLog = [];
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length) {
    const byPath = new Map();
    for (const e of edits) { const ep = pagesPath(e.path); if (!byPath.has(ep)) byPath.set(ep, []); byPath.get(ep).push(e); }
    for (const [ep, list] of byPath) {
      if (!manifest[ep]) throw new Error(`${ep} is not in the live site; send it in files to add it`);
      let text = new TextDecoder().decode(await pagesFetchLiveFile(base.url, ep));
      for (const e of list) {
        const find = String(e.find ?? ""), repl = String(e.replace ?? "");
        if (!find) throw new Error("each edit needs find (exact text from the live file)");
        let n = 0, k = text.indexOf(find); while (k !== -1) { n++; k = text.indexOf(find, k + find.length); }
        const want = e.count != null ? Number(e.count) : 1;
        if (n !== want) throw new Error(`${ep}: find text occurs ${n} time(s), expected ${want}. Use pages_read_file with find to see the exact live text.`);
        text = text.split(find).join(repl);
        editLog.push({ path: ep, occurrences: n, find_chars: find.length, replace_chars: repl.length });
      }
      if (/\.html?$/i.test(ep)) {
        const before = new TextDecoder().decode(await pagesFetchLiveFile(base.url, ep));
        const broke = pagesJsonBlocks(before).filter((b) => b.ok).length - pagesJsonBlocks(text).filter((b) => b.ok).length;
        if (broke > 0) {
          const bad = pagesJsonBlocks(text).filter((b) => !b.ok).map((b) => b.error).slice(0, 3);
          throw new Error(`${ep}: this edit breaks ${broke} JSON block(s) in <script> tags (e.g. a widget config). Nothing deployed. ${bad.join(" | ")}`);
        }
      }
      files.push({ path: ep, content: text });
    }
  }
  const deletes = (Array.isArray(args.delete) ? args.delete : []).map(pagesPath);
  if (!files.length && !deletes.length) throw new Error("give edits [{path, find, replace}] (best) or files [{path, content}] with ONLY the changed files");
  if (files.length > PATCH_MAX_FILES) throw new Error(`too many files for a patch (max ${PATCH_MAX_FILES}); use pages_deploy for a full site`);

  const stored = await pagesSpecialGet(env, account, project);
  const special = {};
  for (const k of ["_redirects", "_headers", "_routes.json"]) if (stored && typeof stored[k] === "string") special[k] = stored[k];
  let specialFromArgs = false;
  const entries = [];
  let total = 0;
  for (const f of files) {
    const path = pagesPath(f.path);
    const bytes = f.content_base64 != null ? b64ToBytes(f.content_base64) : new TextEncoder().encode(String(f.content ?? ""));
    if (bytes.length > PAGES_MAX_FILE) throw new Error(`${path} is over 25 MiB`);
    total += bytes.length;
    if (path === "/_headers" || path === "/_redirects" || path === "/_routes.json") { special[path.slice(1)] = new TextDecoder().decode(bytes); specialFromArgs = true; continue; }
    if (path.startsWith("/functions/") || path.startsWith("/_worker")) throw new Error("functions/_worker need a build step; patch static files only");
    const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    const b64 = bytesToB64(bytes);
    entries.push({ path, b64, ext, size: bytes.length, type: PAGES_TYPES[ext.toLowerCase()] || "application/octet-stream", hash: await pagesHash(b64, ext) });
  }
  if (total > PAGES_MAX_BYTES) throw new Error("patch over 60 MiB");
  if (!special._redirects && !special._headers && args.no_redirects !== true) {
    return { error: `the hub has no saved _redirects/_headers for ${project}, and Cloudflare doesn't return them. Include them in files, or pass no_redirects=true if the site has none.` };
  }

  const changed = entries.map((e) => ({ path: e.path, action: manifest[e.path] ? (manifest[e.path] === e.hash ? "same" : "replace") : "add", bytes: e.size }));
  const missingDeletes = deletes.filter((d) => !manifest[d]);
  const plan = {
    project, account, branch, production, domains_affected: production ? p.domains : [],
    base_deployment: live.id, live_files: Object.keys(base.files || {}).length,
    changed, edits: editLog, deleted: deletes.filter((d) => manifest[d]), delete_not_found: missingDeletes,
    special_files: Object.keys(special), special_source: specialFromArgs ? "sent in this call" : "hub saved copy",
    rollback_hint: { tool: "pages_rollback", deployment_id: live.id },
  };
  if (args.apply !== true) return { dry_run: true, ...plan, warning: production ? "PRODUCTION: only the files above change on " + (p.domains || []).join(", ") : "preview branch only", next: "call again with apply=true" };

  for (const e of entries) manifest[e.path] = e.hash;
  for (const d of deletes) delete manifest[d];

  const { result: up } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/upload-token`);
  const jwt = up && up.jwt;
  if (!jwt) throw new Error("no upload token from Cloudflare");
  const assets = async (path, body) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/pages/assets/${path}`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.success) throw new Error(`pages assets/${path} failed: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`);
    return j.result;
  };
  if (entries.length) {
    const unique = [...new Map(entries.map((e) => [e.hash, e])).values()];
    const missing = new Set(await assets("check-missing", { hashes: unique.map((e) => e.hash) }));
    const batch = unique.filter((e) => missing.has(e.hash)).map((e) => ({ key: e.hash, value: e.b64, metadata: { contentType: e.type }, base64: true }));
    if (batch.length) await assets("upload", batch);
    await assets("upsert-hashes", { hashes: unique.map((e) => e.hash) });
  }

  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  form.append("branch", branch);
  form.append("commit_message", String(args.commit_message || `patch: ${changed.map((c) => c.path).join(", ")}`).slice(0, 380));
  if (args.commit_hash) form.append("commit_hash", String(args.commit_hash).slice(0, 64));
  form.append("commit_dirty", "true");
  for (const [name, text] of Object.entries(special)) form.append(name, new File([text], name, { type: "text/plain" }));
  if (worker) {
    form.append("_worker.bundle", new File([b64ToBytes(worker.bundle_b64)], "_worker.bundle"));
    if (worker.routes) form.append("_routes.json", new File([worker.routes], "_routes.json"));
    // anything else wrangler sent for this project (Functions routing config, wrangler config hash, ...)
    for (const [name, part] of Object.entries(worker.extra || {})) {
      if (part.file) form.append(name, new File([b64ToBytes(part.b64)], name));
      else form.append(name, new TextDecoder().decode(b64ToBytes(part.b64)));
    }
  }
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/deployments`, { method: "POST", headers: { authorization: `Bearer ${client._token}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`create deployment failed: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`);
  if (specialFromArgs) await pagesSpecialPut(env, account, project, special);

  // Server-code sites: prove the new deployment still works (title + worker endpoints) or roll back.
  if (worker && production) {
    const health = await pagesHealth(j.result.url, worker);
    if (!health.ok) {
      let rolled = null;
      try { await client.request("POST", `/accounts/${account}/pages/projects/${project}/deployments/${live.id}/rollback`); rolled = live.id; } catch (e) { rolled = "ROLLBACK FAILED: " + String(e.message || e).slice(0, 120); }
      return { error: "health check failed after deploy; rolled back automatically", rolled_back_to: rolled, health, deployment: { id: j.result.id, url: j.result.url } };
    }
    worker.deployments = [...new Set([...(worker.deployments || []), worker.for_deployment, j.result.id])].slice(-50);
    worker.for_deployment = j.result.id;
    worker.updated_by_patch = new Date().toISOString();
    await env.CLOUDFLARE_OPS_OAUTH.put(`pages:worker:${account}:${project}`, JSON.stringify(worker));
    plan.health = health;
  }

  // check each changed file on the new deployment's own URL (bypasses any proxy/cache in front of the domain)
  const checks = [];
  for (const e of entries.slice(0, 10)) {
    try {
      const u = new URL(e.path, j.result.url);
      let res, ok = false;
      for (let i = 0; i < 5 && !ok; i++) {
        if (i) await new Promise((r) => setTimeout(r, 3000));
        res = await fetch(u.toString(), { redirect: "follow" });
        ok = res.status === 200 && (await pagesHash(bytesToB64(new Uint8Array(await res.arrayBuffer())), e.ext)) === e.hash;
      }
      checks.push({ path: e.path, status: res.status, matches: ok });
    } catch (err) { checks.push({ path: e.path, error: String(err.message || err).slice(0, 120) }); }
  }
  if (env && env.CLOUDFLARE_OPS_OAUTH) {
    await env.CLOUDFLARE_OPS_OAUTH.put(`patchlog:${project}:${Date.now()}`, JSON.stringify({ account, project, branch, base: live.id, deployment: j.result.id, changed, deleted: plan.deleted, actor: actor || "unknown", at: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 90 });
  }
  return { applied: true, ...plan, deployment: { id: j.result.id, url: j.result.url, environment: j.result.environment }, checks, note: "Checks hit the deployment URL. The custom domain can take ~30s to show it." };
}

async function pagesSaveSpecial(client, args, env) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  await pagesGetProject(client, account, project);
  const special = {};
  for (const k of ["_redirects", "_headers", "_routes.json"]) if (typeof args[k] === "string") special[k] = args[k];
  if (!Object.keys(special).length) {
    const cur = await pagesSpecialGet(env, account, project);
    return { project, saved: cur ? Object.keys(cur).filter((k) => k !== "saved") : [], saved_at: cur && cur.saved, ...(cur || {}) };
  }
  await pagesSpecialPut(env, account, project, special);
  return { ok: true, project, saved: Object.keys(special) };
}

var PAGES_PATCH_TOOL_DEFS = [
  { name: "pages_read_file", description: "Read the RAW text of one file exactly as the live production deployment serves it (no summarizer, no proxy). Use find to get the exact snippet(s) around a string; else returns content in chunks (offset/length). Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, path: { type: "string", description: "e.g. insights.html" }, find: { type: "string" }, around: { type: "number", description: "chars of context each side (default 300)" }, offset: { type: "number" }, length: { type: "number" } }, required: ["account", "project", "path"] } },
  { name: "pages_patch", description: "Change ONLY a few files on a live Pages site (no PC, no full file set). Best: edits [{path, find, replace}] — the hub fetches the live file, replaces the exact text (must match once), and deploys. Or files [{path, content}] for whole changed files. The hub copies the live deployment's file list, swaps in the changes (and removes any in delete), keeps _redirects/_headers, and deploys. Every other file stays exactly as live. Dry-run by default; apply=true deploys. branch = production branch goes LIVE, any other = preview. Returns rollback_hint. Sites with server code (artificialmindhive) re-attach the owner-saved worker bundle and get a title + API health check after deploy, with automatic rollback on failure.",
    inputSchema: { type: "object", properties: {
      account: { type: "string", description: "amh (pain2hustle1) or doors (austinsdoors1)" },
      project: { type: "string" }, branch: { type: "string", description: "default = production branch (LIVE)" },
      edits: { type: "array", description: "exact find/replace on live files", items: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" }, count: { type: "number", description: "expected matches, default 1" } }, required: ["path", "find", "replace"] } },
      files: { type: "array", description: "ONLY the changed/new files", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, content_base64: { type: "string" } }, required: ["path"] } },
      delete: { type: "array", items: { type: "string" }, description: "paths to remove from the site" },
      commit_message: { type: "string" }, apply: { type: "boolean" }, no_redirects: { type: "boolean" },
    }, required: ["account", "project"] } },
  { name: "pages_special_files", description: "Read (no args besides account/project) or save the hub's copy of a project's _redirects/_headers, which pages_patch re-sends on every patch.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, _redirects: { type: "string" }, _headers: { type: "string" } }, required: ["account", "project"] } },
];
