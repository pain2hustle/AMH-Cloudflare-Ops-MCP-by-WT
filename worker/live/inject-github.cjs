// Injects src/github-tools.js into the live hub bundle (run after inject-pages-patch.cjs) -> 0.8.1.
const fs = require("fs"), path = require("path");
const f = path.join(__dirname, "index.js");
let s = fs.readFileSync(f, "utf8");
if (s.includes("GITHUB_TOOL_DEFS")) { console.log("already injected"); process.exit(0); }
const mod = fs.readFileSync(path.join(__dirname, "..", "..", "src", "github-tools.js"), "utf8");
const rep = (a, b) => { if (!s.includes(a)) throw new Error("anchor missing: " + a.slice(0, 60)); s = s.split(a).join(b); };
rep("var PAGES_DEPLOY_TOOLS = new Set(", mod + "\nvar PAGES_DEPLOY_TOOLS = new Set(");
rep("  ...PAGES_PATCH_TOOL_DEFS,\n", "  ...PAGES_PATCH_TOOL_DEFS,\n  ...GITHUB_TOOL_DEFS,\n");
rep("      const namespaces = (await listUpstreams(env)).map((u) => u.namespace);\n      const fed = isFederated(toolName, namespaces);",
`      // GitHub straight from the hub (no PC). pc__repo_* (the PC copies) route here too, so they work with the PC off.
      if (GITHUB_TOOLS.has(toolName) || /^pc__repo_(list|read|commit_push|open_pr)$/.test(toolName)) {
        if (!authContext || authContext.mode !== "admin") return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: "GitHub tools need an admin/agent key" }) }], isError: true });
        const out2 = await runGithubTool(toolName.replace(/^pc__/, ""), args, env, authContext.connectionId || authContext.mode);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out2, null, 2) }], isError: !!(out2 && out2.error) });
      }
      const namespaces = (await listUpstreams(env)).map((u) => u.namespace);
      const fed = isFederated(toolName, namespaces);`);
s = s.replace(/version: "0\.7\.0"/, 'version: "0.8.1"');
fs.writeFileSync(f, s);
console.log("injected github tools 0.8.1");
