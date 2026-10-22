// Injects src/worker-patch.js into the live hub bundle -> 0.15.0 (worker_patch_grant / worker_patch / worker_patch_status).
const fs = require("fs"), path = require("path");
const f = path.join(__dirname, "index.js");
let s = fs.readFileSync(f, "utf8");
if (s.includes("WP_TOOL_DEFS")) { console.log("already injected"); process.exit(0); }
const mod = fs.readFileSync(path.join(__dirname, "..", "..", "src", "worker-patch.js"), "utf8");
const rep = (a, b) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error("anchor x" + n + ": " + a.slice(0, 60)); s = s.replace(a, b); };
rep("var INBOX_TOOL_DEFS = [", mod + "\nvar INBOX_TOOL_DEFS = [");
rep("  ...INBOX_TOOL_DEFS,\n", "  ...INBOX_TOOL_DEFS,\n  ...WP_TOOL_DEFS,\n");
rep("      if (INBOX_TOOLS.has(toolName)) {",
`      if (WP_TOOLS.has(toolName)) {
        if (!authContext || authContext.mode !== "admin") return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: toolName + " is for owner/agent keys" }) }], isError: true });
        const outW = await runWorkerPatchTool(toolName, args, env, authContext.connectionId || "admin");
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(outW, null, 2) }], isError: !!(outW && outW.error) });
      }
      if (INBOX_TOOLS.has(toolName)) {`);
rep('    if (url.pathname === "/task-board") return inboxBoardFetch(request, this.state, this.env);',
    '    if (url.pathname === "/worker-patch") return wpLedgerFetch(request, this.state);\n    if (url.pathname === "/task-board") return inboxBoardFetch(request, this.state, this.env);');
const v = s.match(/version: "0\.14\.3"/g) || [];
if (!v.length) throw new Error("version anchor");
s = s.replace(/version: "0\.14\.3"/g, 'version: "0.15.0"');
fs.writeFileSync(f, s);
console.log("injected worker_patch 0.15.0");
