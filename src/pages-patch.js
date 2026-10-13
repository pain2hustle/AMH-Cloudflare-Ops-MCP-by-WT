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

async function pagesPatch(client, args, env, actor) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const p = await pagesGetProject(client, account, project);
  const branch = String(args.branch || p.production_branch || "main").trim();
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(branch)) throw new Error("bad branch");
  const production = branch === p.production_branch;
  if (PAGES_PROTECTED.has(project) && production) return { error: `${project} production is not patchable yet (its live _worker can't be carried over by the API). Patch a preview branch, or ask Splice/Claude.` };
  const live = p.canonical_deployment;
  if (!live || !live.id) return { error: "project has no live production deployment to patch onto" };
  const { result: base } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/deployments/${live.id}`);
  if (base.uses_functions) return { error: `${project}'s live deployment runs Functions; a patch can't carry them over. Not patchable from here.` };
  const manifest = { ...(base.files || {}) };
  if (!Object.keys(manifest).length) return { error: "Cloudflare returned an empty file list for the live deployment; refusing to patch" };

  const files = Array.isArray(args.files) ? args.files : [];
  const deletes = (Array.isArray(args.delete) ? args.delete : []).map(pagesPath);
  if (!files.length && !deletes.length) throw new Error("files: give ONLY the files you changed, as [{path, content}] or [{path, content_base64}]");
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
    changed, deleted: deletes.filter((d) => manifest[d]), delete_not_found: missingDeletes,
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
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/deployments`, { method: "POST", headers: { authorization: `Bearer ${client._token}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`create deployment failed: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`);
  if (specialFromArgs) await pagesSpecialPut(env, account, project, special);

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
  { name: "pages_patch", description: "Change ONLY a few files on a live Pages site (no PC, no full file set). The hub copies the live deployment's file list, swaps in the files you send (and removes any in delete), keeps _redirects/_headers, and deploys. Every other file stays exactly as live. Dry-run by default; apply=true deploys. branch = production branch goes LIVE, any other = preview. Returns rollback_hint. Not for artificialmindhive production or sites with Functions.",
    inputSchema: { type: "object", properties: {
      account: { type: "string", description: "amh (pain2hustle1) or doors (austinsdoors1)" },
      project: { type: "string" }, branch: { type: "string", description: "default = production branch (LIVE)" },
      files: { type: "array", description: "ONLY the changed/new files", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, content_base64: { type: "string" } }, required: ["path"] } },
      delete: { type: "array", items: { type: "string" }, description: "paths to remove from the site" },
      commit_message: { type: "string" }, apply: { type: "boolean" }, no_redirects: { type: "boolean" },
    }, required: ["account", "project"] } },
  { name: "pages_special_files", description: "Read (no args besides account/project) or save the hub's copy of a project's _redirects/_headers, which pages_patch re-sends on every patch.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, _redirects: { type: "string" }, _headers: { type: "string" } }, required: ["account", "project"] } },
];
