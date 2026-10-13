// Injects src/pages-patch.js into the live hub bundle (worker/live/index.js) -> 0.6.4.
const fs = require("fs"), path = require("path");
const f = path.join(__dirname, "index.js");
let s = fs.readFileSync(f, "utf8");
if (s.includes("PAGES_PATCH_TOOL_DEFS")) { console.log("already injected"); process.exit(0); }
const mod = fs.readFileSync(path.join(__dirname, "..", "..", "src", "pages-patch.js"), "utf8");
const rep = (a, b) => { if (!s.includes(a)) throw new Error("anchor missing: " + a.slice(0, 60)); s = s.replace(a, b); };
rep("var PAGES_DEPLOY_TOOLS = new Set(", mod + "\nvar PAGES_DEPLOY_TOOLS = new Set(");
rep("  ...PAGES_DEPLOY_TOOL_DEFS,\n", "  ...PAGES_DEPLOY_TOOL_DEFS,\n  ...PAGES_PATCH_TOOL_DEFS,\n");
rep("  if (PAGES_DEPLOY_TOOLS.has(name)) return await runPagesDeployTool(",
  `  // stale-catalog aliases: clients that cached the 0.6.3 tool list can still reach the new tools
  if (name === "pages_deploy" && (args.patch === true || Array.isArray(args.edits))) name = "pages_patch";
  if (name === "pages_get_deployment" && args.path) name = "pages_read_file";
  if (name === "pages_patch" || name === "pages_special_files" || name === "pages_read_file") {
    try {
      let c = client;
      if (authContext?.mode === "admin" && env.CLOUDFLARE_API_TOKEN_DOORS && args.account && pagesAccount(args.account) === "1d5fae607a857fc56cd575763bf8f3bc") c = new CloudflareClient({ token: env.CLOUDFLARE_API_TOKEN_DOORS });
      if (name === "pages_read_file") return await pagesReadFile(c, args);
      return name === "pages_patch" ? await pagesPatch(c, args, env, authContext?.connectionId || authContext?.mode) : await pagesSaveSpecial(c, args, env);
    } catch (e) { return { error: String((e && e.message) || e).slice(0, 600) }; }
  }
  if (PAGES_DEPLOY_TOOLS.has(name)) return await runPagesDeployTool(`);
rep('version: "0.6.3"', 'version: "0.8.1"');
rep("A deploy replaces the whole site, so send every file.", "A deploy replaces the whole site, so send every file. To change only a few files on a live site use pages_patch (or pass patch=true with edits [{path,find,replace}] here).");
rep("Details of one Pages deployment: url, branch, stages, commit message. Read-only.", "Details of one Pages deployment: url, branch, stages, commit message. Pass path (+ optional find) to read that file's RAW live text instead. Read-only.");
fs.writeFileSync(f, s);
console.log("injected 0.6.4");
