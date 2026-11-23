// hub 0.15.6: public discovery. initialize, ping, notifications and tools/list answer WITHOUT a key
// (tools/list then shows only the native catalog: no federated or owner tools). tools/call and every
// other method still need a key, and token-less ones still get the OAuth 401 challenge.
// Also adds websiteUrl + icons to serverInfo. Usage: node inject-public-discovery.cjs <in.js> <out.js>
const fs = require("fs");
const [, , inFile, outFile] = process.argv;
let s = fs.readFileSync(inFile, "utf8");
const swap = (from, to) => {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error("expected 1 match, got " + n + " for: " + from.slice(0, 80));
  s = s.replace(from, () => to);
};

swap(`  title: "AMH Walrus Tusk Cloudflare Ops MCP \\u2014 SafeTry Agent Harness",
  version: "0.15.5"
};`, `  title: "AMH Walrus Tusk Cloudflare Ops MCP \\u2014 SafeTry Agent Harness",
  version: "0.15.6",
  websiteUrl: "https://mcp.artificialmindhive.com/",
  icons: [{ src: "https://mcp.artificialmindhive.com/logo.svg", mimeType: "image/svg+xml", sizes: ["any"] }]
};
var PUBLIC_RPC = /* @__PURE__ */ new Set(["initialize", "ping", "tools/list"]);
function isPublicRpc(body) {
  const list = Array.isArray(body) ? body : [body];
  return list.length > 0 && list.length <= 8 && list.every((m) => m && typeof m === "object" && typeof m.method === "string" && (PUBLIC_RPC.has(m.method) || m.method.startsWith("notifications/")));
}
__name(isPublicRpc, "isPublicRpc");`);

swap(`hub_version: "0.15.5"`, `hub_version: "0.15.6"`);

// legacy: answer public methods before the 401, body read once
swap(`  const authContext = await authorizeConnector(env, provided);
  if (!authContext.ok) {
    return new Response(JSON.stringify(rpcError(null, -32001, "unauthorized")), {`, `  let authContext = await authorizeConnector(env, provided);
  let publicBody;
  if (!authContext.ok && !provided) {
    try {
      publicBody = JSON.parse(await request.clone().text());
    } catch {
      publicBody = void 0;
    }
    if (publicBody !== void 0 && isPublicRpc(publicBody)) authContext = { ok: true, mode: "public", caller: "public", keyHash: "pub:" + (request.headers.get("cf-connecting-ip") || "unknown") };
    else publicBody = void 0;
  }
  if (!authContext.ok) {
    return new Response(JSON.stringify(rpcError(null, -32001, "unauthorized")), {`);

swap(`  let body;
  try {
    body = await request.json();
  } catch {`, `  let body = publicBody;
  if (body === void 0) try {
    body = await request.json();
  } catch {`);

swap(`  if (method === "tools/list") {
    if (authContext && authContext.mode === "user") return rpcResult(id, { tools: wtuToolDefs() });`, `  if (method === "tools/list") {
    if (authContext && authContext.mode === "public") return rpcResult(id, { tools: TOOLS });
    if (authContext && authContext.mode === "user") return rpcResult(id, { tools: wtuToolDefs() });`);

// public mode must never reach anything else, even if a later edit widens PUBLIC_RPC
swap(`async function handleRpc(msg, env, authContext) {
  const { id, method, params } = msg || {};
  if (id === void 0 || id === null) return null;`, `async function handleRpc(msg, env, authContext) {
  const { id, method, params } = msg || {};
  if (id === void 0 || id === null) return null;
  if (authContext && authContext.mode === "public" && !PUBLIC_RPC.has(method)) return rpcError(id, -32001, "unauthorized");`);

// OAuth wrapper: token-less public discovery skips the OAuth challenge
swap(`        if (mcp) {
          const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\\s+/i, "");
          if (supplied && (await authorizeConnector2(env, supplied)).ok) return legacy.fetch(request, env, ctx);
        }`, `        if (mcp) {
          const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\\s+/i, "");
          if (supplied && (await authorizeConnector2(env, supplied)).ok) return legacy.fetch(request, env, ctx);
          if (!supplied && request.method === "POST") {
            const text = await request.clone().text();
            let rpc;
            try {
              rpc = text.length <= 65536 ? JSON.parse(text) : void 0;
            } catch {
              rpc = void 0;
            }
            if (rpc !== void 0 && isPublicRpc(rpc)) return legacy.fetch(request, env, ctx);
          }
        }`);

fs.writeFileSync(outFile, s);
console.log("ok", outFile, s.length);
