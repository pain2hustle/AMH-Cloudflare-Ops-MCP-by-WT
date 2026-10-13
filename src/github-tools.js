// github-tools.js — Austin's GitHub (pain2hustle/* and pain2hustle1/*) from the hub, no PC. Same tool names/shapes as
// the PC ops server (repo_list / repo_read / repo_commit_push / repo_open_pr) plus repo_search.
// Writes are fenced in code, because the token itself is broad:
//   - only branches grok/<name> or agent/<name>; never the default branch, never force, never delete a branch
//   - never anything under .github/ (workflows run with repo secrets)
// Uses the git data API, so one call = one commit, however many files.

var GH_OWNER = "pain2hustle";
var GH_OWNERS = ["pain2hustle", "pain2hustle1"]; // Austin's two GitHub accounts (the token is a collaborator on pain2hustle1 repos)
var GH_BRANCH_RE = /^(grok|agent)\/[A-Za-z0-9._-]{1,60}$/;
var GH_MAX_FILES = 100, GH_MAX_BYTES = 20 * 1024 * 1024;

async function gh(env, method, path, body, accept) {
  if (!env.GITHUB_TOKEN) throw new Error("hub has no GITHUB_TOKEN secret");
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: accept || "application/vnd.github+json", "user-agent": "amh-cfops-hub", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (accept && accept.includes("raw") && r.ok) return await r.arrayBuffer();
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`GitHub ${method} ${path.split("?")[0]}: ${r.status} ${j.message || ""}`.trim()); e.status = r.status; throw e; }
  return j;
}
function ghRepo(repo) {
  const s = String(repo || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const name = s.includes("/") ? s.split("/") : [GH_OWNER, s];
  const owner = GH_OWNERS.find((o) => o === name[0].toLowerCase());
  if (!owner || !/^[A-Za-z0-9._-]{1,100}$/.test(name[1])) throw new Error(`repo must be ${GH_OWNERS.join(" or ")}/<name>`);
  return `${owner}/${name[1]}`;
}
function ghPath(p) {
  const s = String(p || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (s.split("/").some((x) => x === ".." || x === ".")) throw new Error(`bad path: ${p}`);
  return s;
}
function ghWritable(path) {
  if (/^\.github(\/|$)/i.test(path)) throw new Error(`${path}: .github/ is off-limits (workflows run with secrets)`);
  return path;
}
var ghEnc = (s) => s.split("/").map(encodeURIComponent).join("/");

async function ghRepoList(env, args) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await gh(env, "GET", `/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator&sort=pushed`);
    out.push(...r);
    if (r.length < 100) break;
  }
  const q = String(args.q || "").toLowerCase();
  return { owners: GH_OWNERS, repos: out.filter((r) => GH_OWNERS.includes(r.owner.login.toLowerCase()) && (!q || (r.name + " " + (r.description || "")).toLowerCase().includes(q)))
    .map((r) => ({ repo: r.full_name, private: r.private, default_branch: r.default_branch, pushed_at: r.pushed_at, description: r.description, url: r.html_url })) };
}

async function ghRead(env, args) {
  const repo = ghRepo(args.repo), path = ghPath(args.path || "");
  const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
  const meta = await gh(env, "GET", `/repos/${repo}/contents/${ghEnc(path)}${ref}`);
  if (Array.isArray(meta)) return { repo, path: path || "/", ref: args.ref || "default", entries: meta.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })) };
  const buf = await gh(env, "GET", `/repos/${repo}/contents/${ghEnc(path)}${ref}`, null, "application/vnd.github.raw");
  const text = new TextDecoder().decode(buf);
  const out = { repo, path, ref: args.ref || "default", sha: meta.sha, bytes: buf.byteLength };
  const find = args.find != null ? String(args.find) : "";
  if (find) {
    const around = Math.min(Math.max(Number(args.around) || 300, 0), 4000), hits = [];
    let i = text.indexOf(find), n = 0;
    while (i !== -1) { n++; if (hits.length < 10) hits.push({ at: i, snippet: text.slice(Math.max(0, i - around), i + find.length + around) }); i = text.indexOf(find, i + 1); }
    return { ...out, find, occurrences: n, hits };
  }
  const offset = Math.max(Number(args.offset) || 0, 0), length = Math.min(Math.max(Number(args.length) || 20000, 1), 60000);
  return { ...out, offset, length, more: offset + length < text.length, content: text.slice(offset, offset + length) };
}

async function ghSearch(env, args) {
  const repo = ghRepo(args.repo), q = String(args.query || "").trim();
  if (!q) throw new Error("query required");
  const r = await gh(env, "GET", `/search/code?per_page=20&q=${encodeURIComponent(q + " repo:" + repo)}`);
  return { repo, query: q, total: r.total_count, results: (r.items || []).map((x) => ({ path: x.path, url: x.html_url })) };
}

async function ghCommitPush(env, args, actor) {
  const repo = ghRepo(args.repo), branch = String(args.branch || "").trim();
  if (!GH_BRANCH_RE.test(branch)) throw new Error("branch must be grok/<name> or agent/<name>");
  const message = String(args.message || "").trim();
  if (!message) throw new Error("message required");
  const files = Array.isArray(args.files) ? args.files : [];
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (!files.length && !edits.length) throw new Error("files [{path, content}] and/or edits [{path, find, replace}] required");
  if (files.length + edits.length > GH_MAX_FILES) throw new Error(`max ${GH_MAX_FILES} files per commit`);
  const info = await gh(env, "GET", `/repos/${repo}`);
  if (branch === info.default_branch) throw new Error("refused: that is the default branch");

  let created = false, headSha;
  try { headSha = (await gh(env, "GET", `/repos/${repo}/git/ref/heads/${ghEnc(branch)}`)).object.sha; }
  catch (e) {
    if (e.status !== 404) throw e;
    headSha = (await gh(env, "GET", `/repos/${repo}/git/ref/heads/${ghEnc(info.default_branch)}`)).object.sha;
    created = true;
  }
  const headCommit = await gh(env, "GET", `/repos/${repo}/git/commits/${headSha}`);

  const tree = [], log = [];
  let total = 0;
  const readAt = async (p) => new TextDecoder().decode(await gh(env, "GET", `/repos/${repo}/contents/${ghEnc(p)}?ref=${headSha}`, null, "application/vnd.github.raw"));
  const byPath = new Map();
  for (const e of edits) { const p = ghWritable(ghPath(e.path)); if (!byPath.has(p)) byPath.set(p, []); byPath.get(p).push(e); }
  for (const [p, list] of byPath) {
    let text = await readAt(p);
    for (const e of list) {
      const find = String(e.find ?? ""), repl = String(e.replace ?? "");
      if (!find) throw new Error("each edit needs find");
      let n = 0, k = text.indexOf(find); while (k !== -1) { n++; k = text.indexOf(find, k + find.length); }
      const want = e.count != null ? Number(e.count) : 1;
      if (n !== want) throw new Error(`${p}: find occurs ${n} time(s), expected ${want}. Use repo_read with find to see the exact text.`);
      text = text.split(find).join(repl);
    }
    files.push({ path: p, content: text });
  }
  for (const f of files) {
    const p = ghWritable(ghPath(f.path));
    if (!p) throw new Error("empty path");
    if (f.delete === true) { tree.push({ path: p, mode: "100644", type: "blob", sha: null }); log.push({ path: p, action: "delete" }); continue; }
    const b64 = f.encoding === "base64" || f.content_base64 != null;
    const content = String(f.content_base64 ?? f.content ?? "");
    total += content.length;
    if (total > GH_MAX_BYTES) throw new Error("commit over 20 MB");
    const blob = await gh(env, "POST", `/repos/${repo}/git/blobs`, { content, encoding: b64 ? "base64" : "utf-8" });
    tree.push({ path: p, mode: "100644", type: "blob", sha: blob.sha });
    log.push({ path: p, action: "write", bytes: content.length });
  }
  const newTree = await gh(env, "POST", `/repos/${repo}/git/trees`, { base_tree: headCommit.tree.sha, tree });
  const author = { name: String(args.author || "Bucktooth (Grok)").slice(0, 80), email: "agents@artificialmindhive.com", date: new Date().toISOString() };
  const commit = await gh(env, "POST", `/repos/${repo}/git/commits`, { message: `${message}\n\nvia cfops hub (${actor || "agent"})`, tree: newTree.sha, parents: [headSha], author });
  if (created) await gh(env, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  else await gh(env, "PATCH", `/repos/${repo}/git/refs/heads/${ghEnc(branch)}`, { sha: commit.sha, force: false });
  return { ok: true, repo, branch, created_branch: created, commit: commit.sha.slice(0, 7), files: log, url: `https://github.com/${repo}/tree/${branch}`, compare: `https://github.com/${repo}/compare/${info.default_branch}...${branch}` };
}

async function ghOpenPr(env, args) {
  const repo = ghRepo(args.repo), branch = String(args.branch || "").trim();
  if (!GH_BRANCH_RE.test(branch)) throw new Error("branch must be grok/<name> or agent/<name>");
  const info = await gh(env, "GET", `/repos/${repo}`);
  const open = await gh(env, "GET", `/repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${encodeURIComponent(branch)}`);
  if (open.length) return { ok: true, existing: true, number: open[0].number, url: open[0].html_url };
  const pr = await gh(env, "POST", `/repos/${repo}/pulls`, { title: String(args.title || branch).slice(0, 200), head: branch, base: info.default_branch, body: String(args.body || "Opened by an agent through the cfops hub. Austin reviews and merges.").slice(0, 20000) });
  return { ok: true, number: pr.number, url: pr.html_url };
}

async function ghMergePr(env, args) {
  const repo = ghRepo(args.repo);
  let num = Number(args.number) || 0;
  if (!num && args.branch) {
    const open = await gh(env, "GET", `/repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${encodeURIComponent(String(args.branch))}`);
    if (!open.length) throw new Error("no open PR for that branch; repo_open_pr first");
    num = open[0].number;
  }
  if (!num) throw new Error("number or branch required");
  const pr = await gh(env, "GET", `/repos/${repo}/pulls/${num}`);
  if (!GH_BRANCH_RE.test(pr.head.ref) || pr.head.repo.full_name !== repo) throw new Error("only grok/* or agent/* PRs from this repo can be merged here");
  const files = await gh(env, "GET", `/repos/${repo}/pulls/${num}/files?per_page=100`);
  const wf = files.filter((x) => /^\.github(\/|$)/i.test(x.filename));
  if (wf.length) throw new Error("PR touches .github/; Austin must merge it himself");
  const m = await gh(env, "PUT", `/repos/${repo}/pulls/${num}/merge`, { merge_method: "merge", commit_title: `Merge #${num}: ${pr.title}`.slice(0, 200) });
  return { ok: true, repo, number: num, merged: m.merged, sha: (m.sha || "").slice(0, 7), into: pr.base.ref, files: files.map((x) => x.filename).slice(0, 50) };
}

var GITHUB_TOOL_DEFS = [
  { name: "repo_list", description: "List Austin's GitHub repos (pain2hustle/* and pain2hustle1/*): default branch, last push, private flag. Optional q filters by name/description. No PC needed.",
    inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "repo_read", description: "Read a file (raw text) or list a folder from a pain2hustle repo at a branch/ref. Use find (+around) to get exact snippets, or offset/length for big files. No PC needed.",
    inputSchema: { type: "object", properties: { repo: { type: "string", description: "pain2hustle/<name>, pain2hustle1/<name>, or <name> (= pain2hustle)" }, path: { type: "string" }, ref: { type: "string" }, find: { type: "string" }, around: { type: "number" }, offset: { type: "number" }, length: { type: "number" } }, required: ["repo"] } },
  { name: "repo_search", description: "Search code inside one pain2hustle repo (GitHub code search). Returns matching file paths.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, query: { type: "string" } }, required: ["repo", "query"] } },
  { name: "repo_commit_push", description: "Commit to a grok/<name> (or agent/<name>) branch on GitHub in ONE commit, no PC. Branch is created from the default branch if new. files [{path, content, encoding?:'base64', delete?:true}] and/or edits [{path, find, replace}] applied to the branch's current file. Never touches the default branch, never force-pushes, never writes .github/.",
    inputSchema: { type: "object", properties: {
      repo: { type: "string" }, branch: { type: "string", description: "grok/<short-name>" }, message: { type: "string" },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, encoding: { type: "string", enum: ["utf8", "base64"] }, delete: { type: "boolean" } }, required: ["path"] } },
      edits: { type: "array", items: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" }, count: { type: "number" } }, required: ["path", "find", "replace"] } },
      author: { type: "string" },
    }, required: ["repo", "branch", "message"] } },
  { name: "repo_open_pr", description: "Open (or find) a pull request from a grok/<name> branch into the default branch so Austin can review and merge.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, branch: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["repo", "branch", "title"] } },
];
GITHUB_TOOL_DEFS.push({ name: "repo_merge_pr", description: "Merge an open grok/* or agent/* pull request into the default branch (normal merge commit, history kept, no force). Refused if the PR touches .github/.",
  inputSchema: { type: "object", properties: { repo: { type: "string" }, number: { type: "number" }, branch: { type: "string", description: "or give the PR's branch" } }, required: ["repo"] } });
var GITHUB_TOOLS = new Set(GITHUB_TOOL_DEFS.map((t) => t.name));
async function runGithubTool(name, args, env, actor) {
  try {
    if (name === "repo_list") return await ghRepoList(env, args);
    if (name === "repo_read") return await ghRead(env, args);
    if (name === "repo_search") return await ghSearch(env, args);
    if (name === "repo_commit_push") return await ghCommitPush(env, args, actor);
    if (name === "repo_open_pr") return await ghOpenPr(env, args);
    if (name === "repo_merge_pr") return await ghMergePr(env, args);
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 600) }; }
  return { error: "unknown repo tool" };
}
