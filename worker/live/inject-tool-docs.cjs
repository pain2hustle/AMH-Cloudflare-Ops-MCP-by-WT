// hub 0.15.7: tool quality. Fills every undescribed argument from ARG_DOCS and adds MCP annotations
// (readOnlyHint / destructiveHint / openWorldHint) to every tool, at tools/list time, without touching
// any tool's behaviour. Never overwrites a description or annotation that a tool already has.
// Usage: node inject-tool-docs.cjs <in.js> <out.js>   (run after inject-public-discovery.cjs)
const fs = require("fs");
const [, , inFile, outFile] = process.argv;
let s = fs.readFileSync(inFile, "utf8");
const swap = (from, to) => {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error("expected 1 match, got " + n + " for: " + from.slice(0, 80));
  s = s.replace(from, () => to);
};

const ARG_DOCS = {
  _approved: "Set true only after the owner approved this exact change. Without it the tool refuses or stays read-only.",
  _headers: "Full new contents of the Pages _headers file.",
  _redirects: "Full new contents of the Pages _redirects file.",
  account: "Cloudflare account alias to act on (for example amh, doors, servicepricer, kodak). Defaults to the hub's main account.",
  action: "Which step to run; see the allowed values. Inspect/status steps are read-only.",
  agent: "Name of the agent claiming or finishing the task.",
  ai: "Bind Workers AI to the Worker as env.AI.",
  apply: "false (default) returns a dry-run diff only; true makes the change.",
  around: "Line number to centre the returned excerpt on.",
  author: "Commit author shown in git history (name, not a credential).",
  backup_sha256: "SHA-256 of the backup taken by the snapshot step; must match before restore.",
  body: "Pull request description (Markdown).",
  branch: "Git branch name.",
  candidate_sha256: "SHA-256 of the staged candidate; must match before verify/deploy.",
  commit_hash: "Git commit hash recorded on the Pages deployment.",
  commit_message: "Message recorded on the deployment.",
  compatibility_date: "Workers compatibility date, YYYY-MM-DD.",
  confirm: "Must be true to run a step that changes anything.",
  cursor: "Pagination cursor returned by the previous call.",
  d1: "D1 bindings to attach: [{binding, database_id}].",
  database: "D1 database name or id.",
  deployment_id: "Cloudflare Pages deployment id.",
  domain: "Domain or zone name, for example example.com.",
  dry_run: "true returns what would change without applying it.",
  edits: "List of {path, old, new} text replacements to apply.",
  expected_snapshot_sha256: "SHA-256 of the snapshot you inspected; the call refuses if live has changed since.",
  failed: "true if the task could not be completed.",
  files: "Files to write: [{path, content}] (content as text or base64).",
  find: "Text to search for; returns the matching excerpt instead of the whole file.",
  force: "Skip the safety check that would otherwise refuse this call. Use with care.",
  grant: "Single-use grant id from worker_patch_grant.",
  id: "Task id.",
  include_done: "Also return finished tasks.",
  job_id: "Research job id returned by agent_research_start.",
  length: "Maximum number of characters or lines to return.",
  limit: "Maximum number of items to return.",
  local_preview_source_sha256: "SHA-256 of the locally previewed source; must match the staged copy.",
  message: "Commit message.",
  name: "Name of the Worker or database to create.",
  no_redirects: "Do not touch the _redirects file.",
  note: "Free-text note saved with the rollback in the audit log.",
  number: "Pull request number.",
  offset: "Start position (characters or lines) for paging through a file.",
  params: "Positional bind values for ? placeholders in the SQL.",
  path: "File path inside the repository or site.",
  per_page: "Items per page.",
  policy: "DMARC policy: none (monitor), quarantine or reject.",
  project: "Cloudflare Pages project name.",
  proxied: "Proxy the record through Cloudflare (orange cloud).",
  q: "Filter repositories by name.",
  query: "Search text.",
  reason: "Why the task is being cancelled.",
  ref: "Git branch, tag or commit to read from. Defaults to the default branch.",
  repo: "GitHub repository as owner/name.",
  request_id: "Patch request id returned by an earlier call.",
  result: "What was done, for the task record.",
  schedule: "Optional repeat schedule for the job, for example {every_minutes}.",
  script: "Name of the Worker script.",
  site: "Site to issue a gate pass for.",
  sql: "SQL statement to run.",
  status: "Filter tasks by status.",
  template_id: "Research template to run.",
  text: "Task text for the receiving agent.",
  title: "Pull request title.",
  to: "Agent the task is for.",
  vars: "Plain-text environment variables to set on the Worker.",
  version_id: "Worker version id."
};
const READ_ONLY = ["scan_zone", "plan_email_auth", "verify_domain", "list_tokens", "who_serves_domain", "account_doctor", "pages_branch_check", "apiary_worker_deployments", "apiary_worker_version", "apiary_r2_objects_list", "pages_list_deployments", "pages_get_deployment", "wrangler_doctor", "pages_read_file", "repo_list", "repo_read", "repo_search", "site_views", "d1_query", "my_tasks", "list_tasks", "worker_patch_status", "agent_research_status", "agent_research_list", "agent_briefing", "federation_list", "policy_list"];
const DESTRUCTIVE = ["delete_dns_record", "revoke_token", "pages_rollback", "pages_cutover", "d1_exec", "repo_merge_pr", "cancel_task", "set_dmarc_policy", "worker_deploy", "worker_patch", "pages_deploy", "pages_patch", "pages_special_files", "apply_dns_record", "federation_remove", "agent_control"];

swap(`var PUBLIC_RPC = /* @__PURE__ */ new Set(["initialize", "ping", "tools/list"]);`, `var PUBLIC_RPC = /* @__PURE__ */ new Set(["initialize", "ping", "tools/list"]);
var ARG_DOCS = ${JSON.stringify(ARG_DOCS)};
var READ_ONLY_TOOLS = new Set(${JSON.stringify(READ_ONLY)});
var DESTRUCTIVE_TOOLS = new Set(${JSON.stringify(DESTRUCTIVE)});
function documentTools(list) {
  return list.map((t) => {
    if (!t || typeof t !== "object") return t;
    const out = { ...t };
    const props = out.inputSchema && out.inputSchema.properties;
    if (props) {
      const np = {};
      for (const [k, v] of Object.entries(props)) np[k] = v && typeof v === "object" && !v.description && ARG_DOCS[k] ? { ...v, description: ARG_DOCS[k] } : v;
      out.inputSchema = { ...out.inputSchema, properties: np };
    }
    if (!out.annotations && !/__/.test(out.name || "")) {
      const ro = READ_ONLY_TOOLS.has(out.name);
      out.annotations = ro ? { readOnlyHint: true, openWorldHint: true } : { readOnlyHint: false, destructiveHint: DESTRUCTIVE_TOOLS.has(out.name), openWorldHint: true };
    }
    return out;
  });
}
__name(documentTools, "documentTools");`);

swap(`    if (authContext && authContext.mode === "public") return rpcResult(id, { tools: TOOLS });
    if (authContext && authContext.mode === "user") return rpcResult(id, { tools: wtuToolDefs() });`, `    if (authContext && authContext.mode === "public") return rpcResult(id, { tools: documentTools(TOOLS) });
    if (authContext && authContext.mode === "user") return rpcResult(id, { tools: documentTools(wtuToolDefs()) });`);
swap(`    return rpcResult(id, { tools: [...TOOLS, ...fed.filter((t) => FIRST.test(t.name)), ...isAdmin ? MGMT_TOOL_DEFS : [], ...fed.filter((t) => !FIRST.test(t.name))] });`, `    return rpcResult(id, { tools: documentTools([...TOOLS, ...fed.filter((t) => FIRST.test(t.name)), ...isAdmin ? MGMT_TOOL_DEFS : [], ...fed.filter((t) => !FIRST.test(t.name))]) });`);
swap(`  version: "0.15.6",`, `  version: "0.15.7",`);
swap(`hub_version: "0.15.6"`, `hub_version: "0.15.7"`);

fs.writeFileSync(outFile, s);
console.log("ok", outFile, s.length);
