// pages-deploy.js — Cloudflare Pages deploy/rollback/inspect over the API, no wrangler, no PC.
// Same rules as every other write here: DRY-RUN unless apply=true. artificialmindhive's
// production branch is refused outright: that site only ships through the amh-hive
// build-hive-dist path (raw deploys buried it 4+ times).
// Upload flow mirrors `wrangler pages deploy`: upload-token -> check-missing -> upload ->
// upsert-hashes -> create deployment with a {path: hash} manifest.

var PAGES_ACCOUNT_ALIASES = { amh: "0ebf6d65d7a9ddccd41cba0b8bd1414c", doors: "1d5fae607a857fc56cd575763bf8f3bc", artificialmindhive: "a08783a0d3715df907ed5ccad38f0dcf" };
var PAGES_PROTECTED = new Set(["artificialmindhive"]);
var PAGES_MAX_FILES = 2000, PAGES_MAX_BYTES = 60 * 1024 * 1024, PAGES_MAX_FILE = 25 * 1024 * 1024;
var PAGES_TYPES = { html: "text/html", htm: "text/html", css: "text/css", js: "application/javascript", mjs: "application/javascript", json: "application/json", txt: "text/plain", xml: "application/xml", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", pdf: "application/pdf", webmanifest: "application/manifest+json", wasm: "application/wasm", glb: "model/gltf-binary" };

function pagesAccount(a) {
  const s = String(a || "").trim().toLowerCase();
  const id = PAGES_ACCOUNT_ALIASES[s] || s;
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("account must be amh, doors, artificialmindhive, or a 32-hex account id");
  return id;
}
function pagesProject(p) {
  const s = String(p || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(s)) throw new Error("project must be a Pages project name");
  return s;
}
function pagesPath(p) {
  let s = String(p || "").replace(/\\/g, "/").replace(/^\.?\/+/, "");
  const parts = s.split("/");
  if (!s || s.includes("\0") || parts.some((x) => x === ".." || x === "." || x === "") ) throw new Error(`bad file path: ${p}`);
  return "/" + parts.join("/");
}
function b64ToBytes(b64) {
  const bin = atob(String(b64 || "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function pagesHash(b64, ext) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b64 + ext));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function pagesGetProject(client, account, project) {
  const { result } = await client.request("GET", `/accounts/${account}/pages/projects/${project}`);
  return result;
}

async function pagesListDeployments(client, args) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
  const p = await pagesGetProject(client, account, project);
  const { result } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/deployments?per_page=${limit}`);
  const liveId = p.canonical_deployment && p.canonical_deployment.id;
  return {
    project, production_branch: p.production_branch, domains: p.domains,
    deployments: (result || []).map((d) => ({ id: d.id, short_id: d.short_id, environment: d.environment, branch: d.deployment_trigger && d.deployment_trigger.metadata && d.deployment_trigger.metadata.branch, url: d.url, created_on: d.created_on, status: d.latest_stage && d.latest_stage.status, serving_production: d.id === liveId })),
  };
}

async function pagesGetDeployment(client, args) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const id = String(args.deployment_id || "").trim();
  if (!/^[a-f0-9-]{8,40}$/.test(id)) throw new Error("deployment_id required");
  const { result: d } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/deployments/${id}`);
  return { id: d.id, short_id: d.short_id, environment: d.environment, url: d.url, aliases: d.aliases, created_on: d.created_on, branch: d.deployment_trigger && d.deployment_trigger.metadata && d.deployment_trigger.metadata.branch, commit_message: d.deployment_trigger && d.deployment_trigger.metadata && d.deployment_trigger.metadata.commit_message, stages: (d.stages || []).map((s) => ({ name: s.name, status: s.status })), is_skipped: d.is_skipped };
}

async function pagesRollback(client, args) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const id = String(args.deployment_id || "").trim();
  if (!/^[a-f0-9-]{8,40}$/.test(id)) throw new Error("deployment_id required");
  const p = await pagesGetProject(client, account, project);
  const { result: d } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/deployments/${id}`);
  const plan = { project, domains: p.domains, current_production: p.canonical_deployment && p.canonical_deployment.id, rollback_to: { id: d.id, url: d.url, created_on: d.created_on, environment: d.environment } };
  if (d.environment !== "production") return { error: "only a past PRODUCTION deployment can be rolled back to", ...plan };
  if (PAGES_PROTECTED.has(project) && !(args.force === true && String(args.note || "").trim())) return { error: `${project} is protected: pass force=true and a note saying why`, ...plan };
  if (args.apply !== true) return { dry_run: true, ...plan, next: "call again with apply=true" };
  const { result } = await client.request("POST", `/accounts/${account}/pages/projects/${project}/deployments/${id}/rollback`);
  return { applied: true, ...plan, new_deployment: result && { id: result.id, url: result.url } };
}

async function pagesDeploy(client, args) {
  const account = pagesAccount(args.account), project = pagesProject(args.project);
  const p = await pagesGetProject(client, account, project);
  const branch = String(args.branch || p.production_branch || "main").trim();
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(branch)) throw new Error("bad branch");
  const production = branch === p.production_branch;
  if (PAGES_PROTECTED.has(project) && production) return { error: `${project} production only ships through the amh-hive build (build-hive-dist + guard). Deploy to a preview branch here, or ask Austin/Claude.` };
  const files = Array.isArray(args.files) ? args.files : [];
  if (!files.length) throw new Error("files: give the COMPLETE built site as [{path, content}] or [{path, content_base64}] (a deploy replaces the whole site)");
  if (files.length > PAGES_MAX_FILES) throw new Error(`too many files (max ${PAGES_MAX_FILES})`);
  const entries = [];
  let total = 0;
  const special = {};
  for (const f of files) {
    const path = pagesPath(f.path);
    const bytes = f.content_base64 != null ? b64ToBytes(f.content_base64) : new TextEncoder().encode(String(f.content ?? ""));
    if (bytes.length > PAGES_MAX_FILE) throw new Error(`${path} is over 25 MiB`);
    total += bytes.length;
    if (path === "/_headers" || path === "/_redirects" || path === "/_routes.json") { special[path.slice(1)] = new TextDecoder().decode(bytes); continue; }
    if (path.startsWith("/functions/")) throw new Error("functions/ needs a build step; this tool uploads static files only");
    const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    const b64 = bytesToB64(bytes);
    entries.push({ path, b64, ext, size: bytes.length, type: PAGES_TYPES[ext.toLowerCase()] || "application/octet-stream" });
  }
  if (total > PAGES_MAX_BYTES) throw new Error("upload over 60 MiB; deploy big sites from a PC with wrangler");
  if (!entries.some((e) => e.path === "/index.html")) return { error: "no /index.html in files. A deploy replaces the WHOLE site, so send every file of the built site." };
  for (const e of entries) e.hash = await pagesHash(e.b64, e.ext);
  const plan = { project, account, branch, production, domains_affected: production ? p.domains : [], files: entries.length + Object.keys(special).length, bytes: total, special_files: Object.keys(special) };
  if (args.apply !== true) return { dry_run: true, ...plan, warning: production ? "PRODUCTION: this replaces the live site on " + (p.domains || []).join(", ") : "preview branch only", next: "call again with apply=true" };

  const { result: up } = await client.request("GET", `/accounts/${account}/pages/projects/${project}/upload-token`);
  const jwt = up && up.jwt;
  if (!jwt) throw new Error("no upload token from Cloudflare");
  const assets = async (path, body) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/pages/assets/${path}`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.success) throw new Error(`pages assets/${path} failed: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`);
    return j.result;
  };
  const unique = [...new Map(entries.map((e) => [e.hash, e])).values()];
  const missing = new Set(await assets("check-missing", { hashes: unique.map((e) => e.hash) }));
  let batch = [], size = 0;
  const flush = async () => { if (batch.length) await assets("upload", batch); batch = []; size = 0; };
  for (const e of unique) {
    if (!missing.has(e.hash)) continue;
    if (batch.length >= 1000 || size + e.b64.length > 40 * 1024 * 1024) await flush();
    batch.push({ key: e.hash, value: e.b64, metadata: { contentType: e.type }, base64: true });
    size += e.b64.length;
  }
  await flush();
  await assets("upsert-hashes", { hashes: unique.map((e) => e.hash) });

  const form = new FormData();
  form.append("manifest", JSON.stringify(Object.fromEntries(entries.map((e) => [e.path, e.hash]))));
  form.append("branch", branch);
  if (args.commit_message) form.append("commit_message", String(args.commit_message).slice(0, 380));
  if (args.commit_hash) form.append("commit_hash", String(args.commit_hash).slice(0, 64));
  form.append("commit_dirty", "true");
  for (const [name, text] of Object.entries(special)) form.append(name, new File([text], name, { type: "text/plain" }));
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/deployments`, { method: "POST", headers: { authorization: `Bearer ${client._token}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`create deployment failed: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`);
  return { applied: true, ...plan, uploaded: missing.size, deployment: { id: j.result.id, url: j.result.url, environment: j.result.environment } };
}

async function wranglerDoctor(client, args, altClient) {
  const out = { accounts: {} };
  const base = client;
  for (const [alias, id] of Object.entries(PAGES_ACCOUNT_ALIASES)) {
    client = (altClient && altClient(id)) || base;
    try {
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const { result } = await client.request("GET", `/accounts/${id}/pages/projects?per_page=10&page=${page}`);
        all.push(...(result || []));
        if (!result || result.length < 10) break;
      }
      let workers = null;
      try { const { result } = await client.request("GET", `/accounts/${id}/workers/scripts`); workers = (result || []).map((w) => w.id); } catch (e) { workers = "unreadable: " + String(e.message || e).slice(0, 80); }
      out.accounts[alias] = { id, pages_projects: all.map((p) => ({ name: p.name, production_branch: p.production_branch, domains: p.domains })), workers };
    } catch (e) {
      out.accounts[alias] = { id, error: String(e.message || e).slice(0, 200) };
    }
  }
  if (args.project) {
    client = (altClient && altClient(pagesAccount(args.account || "amh"))) || base;
    try {
      const account = pagesAccount(args.account || "amh"), project = pagesProject(args.project);
      const p = await pagesGetProject(client, account, project);
      out.project = { name: project, production_branch: p.production_branch, domains: p.domains, live_deployment: p.canonical_deployment && { id: p.canonical_deployment.id, url: p.canonical_deployment.url, created_on: p.canonical_deployment.created_on }, latest: p.latest_deployment && { id: p.latest_deployment.id, env: p.latest_deployment.environment, created_on: p.latest_deployment.created_on } };
    } catch (e) { out.project = { error: String(e.message || e).slice(0, 200) }; }
  }
  return out;
}

var PAGES_DEPLOY_TOOL_DEFS = [
  { name: "pages_deploy", description: "Deploy a COMPLETE built static site to a Cloudflare Pages project through the API (like `wrangler pages deploy`, no PC needed). Dry-run by default; apply=true uploads and deploys. branch = production branch goes LIVE; any other branch is a preview URL. A deploy replaces the whole site, so send every file. Static only (no functions/). artificialmindhive production is refused.",
    inputSchema: { type: "object", properties: {
      account: { type: "string", description: "amh (pain2hustle1), doors (austinsdoors1), artificialmindhive, or an account id" },
      project: { type: "string" }, branch: { type: "string", description: "default = production branch" },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string", description: "text file contents" }, content_base64: { type: "string", description: "binary file contents" } }, required: ["path"] } },
      commit_message: { type: "string" }, commit_hash: { type: "string" }, apply: { type: "boolean" },
    }, required: ["account", "project", "files"] } },
  { name: "pages_list_deployments", description: "List recent deployments of a Pages project, marking the one serving production. Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, limit: { type: "number" } }, required: ["account", "project"] } },
  { name: "pages_get_deployment", description: "Details of one Pages deployment: url, branch, stages, commit message. Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, deployment_id: { type: "string" } }, required: ["account", "project", "deployment_id"] } },
  { name: "pages_rollback", description: "Put a past production deployment back live. Dry-run by default; apply=true rolls back. artificialmindhive needs force=true plus a note.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" }, deployment_id: { type: "string" }, apply: { type: "boolean" }, force: { type: "boolean" }, note: { type: "string" } }, required: ["account", "project", "deployment_id"] } },
  { name: "wrangler_doctor", description: "One-call health check: Pages projects (with production branch + domains) and Workers on both accounts, plus live vs latest deployment for one project. Read-only.",
    inputSchema: { type: "object", properties: { account: { type: "string" }, project: { type: "string" } } } },
];
var PAGES_DEPLOY_TOOLS = new Set(PAGES_DEPLOY_TOOL_DEFS.map((t) => t.name));
// altClient(accountId) may return a client for another account (the owner's second Cloudflare login).
async function runPagesDeployTool(name, args, client, altClient) {
  try {
    if (altClient && args.account && name !== "wrangler_doctor") { const alt = altClient(pagesAccount(args.account)); if (alt) client = alt; }
    if (name === "pages_deploy") return await pagesDeploy(client, args);
    if (name === "pages_list_deployments") return await pagesListDeployments(client, args);
    if (name === "pages_get_deployment") return await pagesGetDeployment(client, args);
    if (name === "pages_rollback") return await pagesRollback(client, args);
    if (name === "wrangler_doctor") return await wranglerDoctor(client, args, altClient);
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 600) };
  }
  return { error: "unknown pages tool" };
}

export { PAGES_DEPLOY_TOOL_DEFS, PAGES_DEPLOY_TOOLS, runPagesDeployTool };
