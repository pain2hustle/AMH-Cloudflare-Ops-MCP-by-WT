// Injects src/wt-users.js (self-serve user keys) into the live hub bundle. Run after inject-github.cjs -> 0.9.1.
const fs = require("fs"), path = require("path");
const f = path.join(__dirname, "index.js");
let s = fs.readFileSync(f, "utf8");
if (s.includes("WTU_PREFIX")) { console.log("already injected"); process.exit(0); }
const mod = ["sealed-box.js", "autodeploy.js", "wt-users.js"].map((n) => fs.readFileSync(path.join(__dirname, "..", "..", "src", n), "utf8")).join("\n");
const rep = (a, b) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`anchor found ${n}x: ` + a.slice(0, 70)); s = s.replace(a, () => b); };
rep("var PAGES_DEPLOY_TOOLS = new Set(", mod + "\nvar PAGES_DEPLOY_TOOLS = new Set(");
// auth: user keys
rep(`  if (!provided) return { ok: false, reason: "missing_connector_key" };\n`,
    `  if (!provided) return { ok: false, reason: "missing_connector_key" };\n  if (provided.startsWith(WTU_PREFIX)) return await wtuAuthorize(env, provided);\n`);
// tools/list: user keys only see their allowlist
rep(`  if (method === "tools/list") {\n    let fed = [];`,
    `  if (method === "tools/list") {\n    if (authContext && authContext.mode === "user") return rpcResult(id, { tools: wtuToolDefs() });\n    let fed = [];`);
// tools/call: user keys go to their own creds, before any owner/federated path
rep(`    try {\n      if (MGMT_TOOLS.has(toolName)) {`,
    `    try {\n      if (authContext && authContext.mode === "user") {\n        const outU = await wtuCallTool(toolName, args, env, authContext);\n        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(outU, null, 2) }], isError: !!(outU && outU.error) });\n      }\n      if (MGMT_TOOLS.has(toolName)) {`);
// HTTP: /join + /setup
rep(`  if (url.pathname === "/oauth/cloudflare/start") return handleOAuthStart(request, env);`,
    `  { const wtr = await wtuHandleHttp(request, env, url); if (wtr) return wtr; }\n  if (url.pathname === "/oauth/cloudflare/start") return handleOAuthStart(request, env);`);
s = s.replace(/version: "0\.8\.\d"/, 'version: "0.9.1"');
fs.writeFileSync(f, s);
console.log("injected wt users 0.9.1");
