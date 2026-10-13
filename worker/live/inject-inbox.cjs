// Injects src/inbox.js (agent inbox + /board) into the live hub bundle. Run after inject-wt-users.cjs -> 0.10.0.
const fs = require("fs"), path = require("path");
const f = path.join(__dirname, "index.js");
let s = fs.readFileSync(f, "utf8");
if (s.includes("INBOX_TOOL_DEFS")) { console.log("already injected"); process.exit(0); }
const mod = fs.readFileSync(path.join(__dirname, "..", "..", "src", "inbox.js"), "utf8");
const rep = (a, b) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`anchor found ${n}x: ` + a.slice(0, 70)); s = s.replace(a, () => b); };
rep("var PAGES_DEPLOY_TOOLS = new Set(", mod + "\nvar PAGES_DEPLOY_TOOLS = new Set(");
// inbox tools right after pages/github so connector apps with a tool cap still see them
rep("  ...GITHUB_TOOL_DEFS,\n", "  ...GITHUB_TOOL_DEFS,\n  ...INBOX_TOOL_DEFS,\n");
rep("      // GitHub straight from the hub (no PC).",
`      if (INBOX_TOOLS.has(toolName)) {
        if (!authContext || authContext.mode !== "admin") return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: "the agent inbox is for owner/agent keys" }) }], isError: true });
        const outI = await runInboxTool(toolName, args, env, null);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(outI, null, 2) }], isError: !!(outI && outI.error) });
      }
      // GitHub straight from the hub (no PC).`);
rep("  { const wtr = await wtuHandleHttp(request, env, url); if (wtr) return wtr; }",
    "  { const ibr = await inboxHandleHttp(request, env, url); if (ibr) return ibr; }\n  { const wtr = await wtuHandleHttp(request, env, url); if (wtr) return wtr; }");
s = s.replace(/version: "0\.9\.\d"/, 'version: "0.10.0"');
fs.writeFileSync(f, s);
console.log("injected inbox 0.10.0");
