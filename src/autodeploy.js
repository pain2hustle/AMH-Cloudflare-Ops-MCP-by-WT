// autodeploy.js — phase 2 for Walrus Tusk users: sites with server code (Functions / _worker) deploy
// from the user's GitHub repo through GitHub Actions, so no PC is ever needed.
//   site_autodeploy: (1) makes sure the Pages project exists, (2) stores CLOUDFLARE_API_TOKEN +
//   CLOUDFLARE_ACCOUNT_ID as encrypted repo secrets (libsodium sealed box, see sealed-box.js),
//   (3) opens a PR adding .github/workflows/walrus-tusk-deploy.yml. The USER taps Merge — that is
//   their consent; the hub never writes the default branch or .github/ directly.
//   After that, every push/merge to the default branch builds + deploys the whole site.

var AD_WORKFLOW_PATH = ".github/workflows/walrus-tusk-deploy.yml";
var AD_BRANCH = "agent/walrus-tusk-autodeploy";

function adWorkflow({ deployBranch, project, prodBranch, outputDir, buildCommand, rootDir }) {
  const lines = [
    "# Added by Walrus Tusk (mcp.artificialmindhive.com). Deploys this repo to Cloudflare Pages",
    "# on every push to the default branch. Uses the repo secrets CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID.",
    "name: Walrus Tusk deploy",
    "on:",
    "  push:",
    `    branches: [${JSON.stringify(deployBranch)}]`,
    "  workflow_dispatch:",
    "concurrency:",
    "  group: walrus-tusk-deploy",
    "  cancel-in-progress: false",
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 20",
  ];
  if (buildCommand) lines.push("      - name: Build", `        working-directory: ${JSON.stringify(rootDir)}`, "        run: |", `          ${buildCommand}`);
  lines.push(
    "      - name: Deploy to Cloudflare Pages",
    "        uses: cloudflare/wrangler-action@v3",
    "        with:",
    "          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    `          workingDirectory: ${JSON.stringify(rootDir)}`,
    `          command: pages deploy ${outputDir} --project-name=${project} --branch=${prodBranch} --commit-dirty=true`,
  );
  return lines.join("\n") + "\n";
}

function adBytes(s) { return new TextEncoder().encode(s); }
function adB64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function adUnb64(s) { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; }

async function siteAutodeploy(cfClient, cfToken, accountId, ghEnv, args) {
  const repo = ghRepo(args.repo, ghEnv);
  const project = pagesProject(args.project);
  const outputDir = String(args.output_dir || ".").trim() || ".";
  const rootDir = String(args.root_dir || ".").trim() || ".";
  for (const [k, v] of [["output_dir", outputDir], ["root_dir", rootDir]]) if (!/^[A-Za-z0-9._/-]{1,120}$/.test(v) || v.includes("..")) throw new Error(`${k} must be a simple relative folder like "." or "dist"`);
  const buildCommand = String(args.build_command || "").trim();
  if (/[\r\n]/.test(buildCommand) || buildCommand.length > 300) throw new Error("build_command must be one line (e.g. npm ci && npm run build)");

  const info = await gh(ghEnv, "GET", `/repos/${repo}`);
  const deployBranch = String(args.deploy_branch || info.default_branch);
  let proj = null, created = false;
  try { proj = await pagesGetProject(cfClient, accountId, project); } catch (e) { if (!/not found|8000007|404/i.test(String(e.message))) throw e; }
  const prodBranch = proj ? proj.production_branch : "main";
  const workflow = adWorkflow({ deployBranch, project, prodBranch, outputDir, buildCommand, rootDir });
  const plan = {
    repo, deploys_on_push_to: deployBranch, pages_project: project, project_exists: !!proj, live_domains: proj ? proj.domains : [`${project}.pages.dev (new)`],
    production_branch: prodBranch, secrets_to_set: ["CLOUDFLARE_API_TOKEN (your saved Cloudflare token)", "CLOUDFLARE_ACCOUNT_ID"],
    workflow_file: AD_WORKFLOW_PATH, workflow,
    after: "A pull request opens in your repo. Tap Merge in the GitHub app: from then on every merge to " + deployBranch + " deploys the whole site, server code included.",
  };
  if (args.apply !== true) return { dry_run: true, ...plan, next: "call again with apply=true" };

  if (!proj) {
    const { result } = await cfClient.request("POST", `/accounts/${accountId}/pages/projects`, { name: project, production_branch: "main" });
    proj = result; created = true;
  }
  // repo secrets (sealed box with the repo's public key)
  const pk = await gh(ghEnv, "GET", `/repos/${repo}/actions/secrets/public-key`);
  for (const [name, value] of [["CLOUDFLARE_API_TOKEN", cfToken], ["CLOUDFLARE_ACCOUNT_ID", accountId]]) {
    const sealed = wtSealedBox(adBytes(value), adUnb64(pk.key));
    await gh(ghEnv, "PUT", `/repos/${repo}/actions/secrets/${name}`, { encrypted_value: adB64(sealed), key_id: pk.key_id });
  }
  // workflow on a branch + PR (never the default branch)
  const head = (await gh(ghEnv, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(info.default_branch)}`)).object.sha;
  try { await gh(ghEnv, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${AD_BRANCH}`, sha: head }); }
  catch (e) { if (e.status !== 422) throw e; } // branch already exists
  let existingSha;
  try { existingSha = (await gh(ghEnv, "GET", `/repos/${repo}/contents/${AD_WORKFLOW_PATH}?ref=${encodeURIComponent(AD_BRANCH)}`)).sha; } catch (e) { if (e.status !== 404) throw e; }
  await gh(ghEnv, "PUT", `/repos/${repo}/contents/${AD_WORKFLOW_PATH}`, { message: "Walrus Tusk: deploy to Cloudflare Pages on push", content: adB64(adBytes(workflow)), branch: AD_BRANCH, ...(existingSha ? { sha: existingSha } : {}) });
  let pr;
  const open = await gh(ghEnv, "GET", `/repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${encodeURIComponent(AD_BRANCH)}`);
  if (open.length) pr = open[0];
  else pr = await gh(ghEnv, "POST", `/repos/${repo}/pulls`, { title: "Walrus Tusk: auto-deploy to Cloudflare Pages", head: AD_BRANCH, base: info.default_branch, body: `Adds \`${AD_WORKFLOW_PATH}\`. After you merge, every push to \`${deployBranch}\` deploys \`${outputDir}\` to the Cloudflare Pages project **${project}** (${(proj.domains || []).join(", ") || project + ".pages.dev"}).\n\nRepo secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID were set by Walrus Tusk. Remove them under Settings → Secrets → Actions to turn this off.` });
  return { applied: true, ...plan, project_created: created, secrets_set: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], pull_request: pr.html_url, next: "Tap Merge on that pull request. The first deploy starts right after; check it with site_autodeploy_status." };
}

async function siteAutodeployStatus(ghEnv, args) {
  const repo = ghRepo(args.repo, ghEnv);
  let runs;
  try { runs = await gh(ghEnv, "GET", `/repos/${repo}/actions/workflows/walrus-tusk-deploy.yml/runs?per_page=5`); }
  catch (e) { if (e.status === 404) return { repo, set_up: false, note: "No Walrus Tusk deploy workflow on the default branch yet. Run site_autodeploy, then merge its PR." }; throw e; }
  return { repo, set_up: true, runs: (runs.workflow_runs || []).map((r) => ({ status: r.status, result: r.conclusion, commit: (r.head_sha || "").slice(0, 7), message: (r.display_title || "").slice(0, 80), started: r.run_started_at, url: r.html_url })) };
}

var AUTODEPLOY_TOOL_DEFS = [
  { name: "site_autodeploy", description: "One-time setup for sites with server code (Functions/_worker), or any site you keep in GitHub: deploys the repo to a Cloudflare Pages project on every push via GitHub Actions — no PC. Sets the repo secrets and opens a pull request adding the workflow; the user taps Merge to turn it on. Dry-run by default; apply=true does it. After that, change the site with repo_commit_push + repo_open_pr + repo_merge_pr.",
    inputSchema: { type: "object", properties: {
      repo: { type: "string", description: "owner/name" }, project: { type: "string", description: "Cloudflare Pages project (created if it doesn't exist)" },
      account: { type: "string" }, output_dir: { type: "string", description: "folder to deploy, default '.'" },
      build_command: { type: "string", description: "optional, one line, e.g. npm ci && npm run build" }, root_dir: { type: "string", description: "repo subfolder to work in, default '.'" },
      deploy_branch: { type: "string", description: "default: the repo's default branch" }, apply: { type: "boolean" },
    }, required: ["repo", "project"] } },
  { name: "site_autodeploy_status", description: "Latest Walrus Tusk deploy runs for a repo (queued / running / success / failure, with links).",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
];
