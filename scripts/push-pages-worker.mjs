// push-pages-worker.mjs — let agents pages_patch a Pages site that runs server code (Functions/_worker).
//
// Cloudflare never returns a deployment's server code, so this captures the exact upload
// `wrangler pages deploy` makes for a site folder (against a fake local API — nothing is deployed),
// checks the captured file list is byte-identical to what is LIVE, and stores the server parts +
// _headers/_redirects in the hub's KV tagged with the live deployment id. Run it after each deploy.
//
//   node scripts/push-pages-worker.mjs --site walo [--dry]
//   node scripts/push-pages-worker.mjs --account doors --project walo --cwd <dir> --dir . --title "..." [--dry]
//
// amh-hive has its own copy for artificialmindhive (scripts/push-hive-worker-to-hub.mjs).

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SITES = {
  walo: {
    account: "doors", project: "walo", cwd: "C:/Users/Servi/walo-locale-live/walo-site", dir: ".",
    title: "WALO — AI Assistant and WhatsApp Command Hub",
    checks: [
      { path: "/app/walo/", status: 200, contains: "<title>WALO App — AI Command Hub" },
      { path: "/dash", status: 401 },
      { path: "/login", status: 200 },
    ],
  },
};
const ACCOUNTS = { amh: "0ebf6d65d7a9ddccd41cba0b8bd1414c", doors: "1d5fae607a857fc56cd575763bf8f3bc" };
const KV_ACCOUNT = ACCOUNTS.amh, KV_NS = "4d55e8a9a8c54d9d8e03253542e0dbdb"; // hub KV lives on amh
const SKIP = new Set(["manifest", "branch", "commit_message", "commit_hash", "commit_dirty", "_headers", "_redirects", "_worker.bundle", "_routes.json"]);

const arg = (k) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : undefined; };
const site = arg("site") ? SITES[arg("site")] : { account: arg("account"), project: arg("project"), cwd: arg("cwd"), dir: arg("dir") || ".", title: arg("title"), checks: [] };
if (!site || !site.project || !site.cwd) throw new Error("use --site <name> (" + Object.keys(SITES).join(", ") + ") or --account/--project/--cwd");
const ACCOUNT = ACCOUNTS[site.account] || site.account;
const dry = process.argv.includes("--dry");
const tokens = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".amh-secrets", "agent-ops-cf.json"), "utf8"));
const tokenFor = (acct) => (Object.values(tokens).find((t) => t.account === acct) || {}).token;
const cf = async (acct, method, p, body, headers = {}) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${p}`, { method, headers: { authorization: `Bearer ${tokenFor(acct)}`, ...headers }, body });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`${method} ${p}: ${JSON.stringify(j.errors || r.status)}`);
  return j.result;
};

async function capture() {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64u({ alg: "HS256" })}.${b64u({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  const ok = (r) => JSON.stringify({ success: true, errors: [], messages: [], result: r });
  let form = null, ctype = "";
  const server = http.createServer((q, s) => {
    const chunks = [];
    q.on("data", (c) => chunks.push(c));
    q.on("end", () => {
      const u = q.url;
      s.setHeader("content-type", "application/json");
      if (/upload-token/.test(u)) return s.end(ok({ jwt }));
      if (/check-missing/.test(u)) return s.end(ok([]));
      if (q.method === "POST" && /\/deployments$/.test(u)) { form = Buffer.concat(chunks); ctype = q.headers["content-type"]; }
      if (/\/deployments/.test(u)) return s.end(ok({ id: "0", url: "https://captured.invalid", latest_stage: { name: "deploy", status: "success" }, stages: [] }));
      if (/\/pages\/projects\/[^/]+$/.test(u)) return s.end(ok({ name: site.project, production_branch: "main", deployment_configs: { production: {}, preview: {} } }));
      s.end(ok(true));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { ...process.env, CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${server.address().port}/client/v4`, CLOUDFLARE_API_TOKEN: "capture-only", CLOUDFLARE_ACCOUNT_ID: ACCOUNT, WRANGLER_SEND_METRICS: "false", CI: "1", WRANGLER_CACHE_DIR: path.join(os.tmpdir(), "pages-cap-cache") };
  const code = await new Promise((r) => {
    const p = spawn("npx", ["-y", "wrangler@4.127.1", "pages", "deploy", site.dir, "--project-name", site.project, "--branch", "main", "--commit-dirty=true"], { cwd: site.cwd, env, shell: true, stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", r);
  });
  server.close();
  if (code !== 0 || !form) throw new Error("capture failed (wrangler exit " + code + ")");
  const boundary = ctype.split("boundary=")[1];
  const parts = {};
  for (const p of form.toString("latin1").split("--" + boundary).slice(1, -1)) {
    const i = p.indexOf("\r\n\r\n");
    const hd = p.slice(0, i);
    parts[hd.match(/name="([^"]+)"/)[1]] = { buf: Buffer.from(p.slice(i + 4, -2), "latin1"), file: /filename="/.test(hd) };
  }
  return parts;
}

const parts = await capture();
if (!parts["_worker.bundle"]) throw new Error("no server code in the capture; this site doesn't need this script (pages_patch works without it)");
const manifest = JSON.parse(parts.manifest.buf.toString());
const proj = await cf(ACCOUNT, "GET", `/accounts/${ACCOUNT}/pages/projects/${site.project}`);
const live = proj.canonical_deployment;
const dep = await cf(ACCOUNT, "GET", `/accounts/${ACCOUNT}/pages/projects/${site.project}/deployments/${live.id}`);
const liveFiles = dep.files || {};
const diffs = [];
for (const k of new Set([...Object.keys(liveFiles), ...Object.keys(manifest)])) {
  if (liveFiles[k] === manifest[k]) continue;
  if (!liveFiles[k] || !manifest[k]) { diffs.push(k); continue; }
  const local = path.join(site.cwd, site.dir, ...k.split("/").filter(Boolean));
  const r = await fetch(new URL(k, live.url).toString(), { redirect: "follow" });
  if (!fs.existsSync(local) || !Buffer.from(await r.arrayBuffer()).equals(fs.readFileSync(local))) diffs.push(k);
}
console.log(`${site.project} live ${live.id.slice(0, 8)}: ${Object.keys(liveFiles).length} files, capture ${Object.keys(manifest).length}, differences ${diffs.length}`);
if (diffs.length) { console.log(diffs.slice(0, 10).join("\n")); throw new Error("the folder is not what is live. Nothing stored."); }
if (dry) { console.log("dry run: matches live, not stored"); process.exit(0); }

const extra = {};
for (const [name, p] of Object.entries(parts)) if (!SKIP.has(name)) extra[name] = { b64: p.buf.toString("base64"), file: p.file };
const put = (key, value) => cf(KV_ACCOUNT, "PUT", `/accounts/${KV_ACCOUNT}/storage/kv/namespaces/${KV_NS}/values/${encodeURIComponent(key)}`, value, { "content-type": "text/plain" });
await put(`pages:worker:${ACCOUNT}:${site.project}`, JSON.stringify({
  bundle_b64: parts["_worker.bundle"].buf.toString("base64"),
  routes: parts["_routes.json"] ? parts["_routes.json"].buf.toString() : null,
  extra, for_deployment: live.id, deployments: [live.id],
  expect_title: site.title || null, checks: site.checks || [],
  saved: new Date().toISOString(), source: `cloudflare-ops-mcp/scripts/push-pages-worker.mjs (${site.cwd})`,
}));
const special = {};
if (parts._redirects) special._redirects = parts._redirects.buf.toString();
if (parts._headers) special._headers = parts._headers.buf.toString();
await put(`pages:special:${ACCOUNT}:${site.project}`, JSON.stringify({ ...special, saved: new Date().toISOString() }));
console.log(`stored server code (${parts["_worker.bundle"].buf.length} bytes, extra: ${Object.keys(extra).join(", ") || "none"}) + ${Object.keys(special).join(", ")} for live ${live.id}`);
