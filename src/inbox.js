// inbox.js — the agent inbox: one shared task board for Austin's agents (Grok, Claude, Jubber, Codex…).
// Chat agents can't be woken from outside, so they PULL: "check your inbox" → my_tasks → claim_task →
// do the work → finish_task. Always-on agents (Jubber on the PC) poll it. Austin posts from the board
// page (/board), from any connected AI, and (later) WhatsApp. Owner/agent (admin) keys only.
// KV: task:<id> (90-day TTL). finish_task can ping Austin on WhatsApp through the federated walo MCP.

var INBOX_AGENTS = ["grok", "claude", "jubber", "codex", "owner", "any"];
var INBOX_TTL = 60 * 60 * 24 * 90;

function inboxId() {
  const r = crypto.getRandomValues(new Uint8Array(4));
  return Date.now().toString(36) + "-" + [...r].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function inboxAgent(a, field) {
  const s = String(a || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,30}$/.test(s)) throw new Error(`${field} must be an agent name like ${INBOX_AGENTS.join(", ")}`);
  return s;
}
async function inboxAll(env) {
  const kv = env.CLOUDFLARE_OPS_OAUTH;
  const out = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const page = await kv.list({ prefix: "task:", cursor, limit: 1000 });
    for (const k of page.keys) { const t = await kv.get(k.name, "json"); if (t) out.push(t); }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out.sort((a, b) => (a.created < b.created ? 1 : -1));
}
async function inboxPut(env, t) { await env.CLOUDFLARE_OPS_OAUTH.put(`task:${t.id}`, JSON.stringify(t), { expirationTtl: INBOX_TTL }); }
async function inboxGet(env, id) {
  if (!/^[a-z0-9]+-[0-9a-f]{8}$/.test(String(id || ""))) throw new Error("bad task id");
  const t = await env.CLOUDFLARE_OPS_OAUTH.get(`task:${id}`, "json");
  if (!t) throw new Error("no such task (done tasks expire after 90 days)");
  return t;
}
var inboxView = (t) => ({ id: t.id, to: t.to, from: t.from, status: t.status, text: t.text, created: t.created, claimed_by: t.claimed_by || null, finished: t.finished || null, result: t.result || null, notify: !!t.notify });

async function inboxNotify(env, t) {
  try {
    const out = await callFederated(env, "walo", "walo_notify", { template: "ping", text: `Task ${t.id} ${t.status} by ${t.claimed_by || t.to}: ${String(t.text).slice(0, 80)}` });
    return { whatsapp: out && !out.error ? "pinged" : "not sent", detail: out && (out.error || out.status || null) };
  } catch (e) { return { whatsapp: "not sent", detail: String(e.message || e).slice(0, 120) }; }
}

async function runInboxTool(name, args, env, who) {
  try {
    if (name === "post_task") {
      const text = String(args.text || "").trim();
      if (!text) throw new Error("text required");
      if (text.length > 4000) throw new Error("text over 4000 chars; link a Drive doc instead");
      const t = { id: inboxId(), to: inboxAgent(args.to || "any", "to"), from: inboxAgent(args.from || who || "owner", "from"), text, status: "open", created: new Date().toISOString(), notify: args.notify !== false };
      await inboxPut(env, t);
      return { ok: true, task: inboxView(t), note: `Waiting for ${t.to}. Chat agents pick it up when someone says "check your inbox".` };
    }
    if (name === "my_tasks") {
      const agent = inboxAgent(args.agent || who, "agent");
      const all = await inboxAll(env);
      const mine = all.filter((t) => (t.to === agent || t.to === "any") && (args.include_done ? true : t.status === "open" || (t.status === "claimed" && t.claimed_by === agent)));
      return { agent, count: mine.length, tasks: mine.slice(0, 25).map(inboxView), how: "claim_task {id, agent} → do it → finish_task {id, agent, result}" };
    }
    if (name === "claim_task") {
      const agent = inboxAgent(args.agent || who, "agent");
      const t = await inboxGet(env, args.id);
      if (t.status === "done" || t.status === "failed") throw new Error(`task already ${t.status}`);
      if (t.status === "claimed" && t.claimed_by !== agent) throw new Error(`already claimed by ${t.claimed_by}`);
      if (t.to !== "any" && t.to !== agent) throw new Error(`task is for ${t.to}, not ${agent}`);
      t.status = "claimed"; t.claimed_by = agent; t.claimed = new Date().toISOString();
      await inboxPut(env, t);
      return { ok: true, task: inboxView(t) };
    }
    if (name === "finish_task") {
      const agent = inboxAgent(args.agent || who, "agent");
      const t = await inboxGet(env, args.id);
      if (t.status === "done" || t.status === "failed") throw new Error(`task already ${t.status}`);
      if (t.claimed_by && t.claimed_by !== agent) throw new Error(`claimed by ${t.claimed_by}`);
      t.status = args.failed === true ? "failed" : "done";
      t.claimed_by = agent; t.finished = new Date().toISOString();
      t.result = String(args.result || "").slice(0, 8000);
      await inboxPut(env, t);
      const ping = t.notify ? await inboxNotify(env, t) : { whatsapp: "off for this task" };
      return { ok: true, task: inboxView(t), ...ping };
    }
    if (name === "list_tasks") {
      const all = await inboxAll(env);
      const f = all.filter((t) => (!args.status || t.status === args.status) && (!args.to || t.to === String(args.to).toLowerCase()));
      return { count: f.length, tasks: f.slice(0, Math.min(Number(args.limit) || 30, 100)).map(inboxView) };
    }
    if (name === "cancel_task") {
      const t = await inboxGet(env, args.id);
      if (t.status === "done") throw new Error("already done");
      t.status = "failed"; t.result = "cancelled: " + String(args.reason || "").slice(0, 300); t.finished = new Date().toISOString();
      await inboxPut(env, t);
      return { ok: true, task: inboxView(t) };
    }
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 600) }; }
  return { error: "unknown inbox tool" };
}

var INBOX_TOOL_DEFS = [
  { name: "my_tasks", description: "Check your inbox: open tasks for you (or for 'any'). Run this when Austin says 'check your inbox'. Then claim_task → do the work → finish_task.",
    inputSchema: { type: "object", properties: { agent: { type: "string", description: "your name: grok, claude, jubber, codex" }, include_done: { type: "boolean" } }, required: ["agent"] } },
  { name: "post_task", description: "Give a task to another agent (or yourself later) on the shared AMH agent board. to: grok | claude | jubber | codex | owner (Austin) | any.",
    inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" }, from: { type: "string", description: "your name" }, notify: { type: "boolean", description: "WhatsApp-ping Austin when it's finished (default true)" } }, required: ["to", "text", "from"] } },
  { name: "claim_task", description: "Claim an inbox task before working on it, so no other agent does it twice.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, agent: { type: "string" } }, required: ["id", "agent"] } },
  { name: "finish_task", description: "Mark an inbox task done (or failed=true) with a short result: what you did, links, deployment ids. Pings Austin on WhatsApp if the task asked for it.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, agent: { type: "string" }, result: { type: "string" }, failed: { type: "boolean" } }, required: ["id", "agent", "result"] } },
  { name: "list_tasks", description: "The whole agent board: every task, optionally by status (open/claimed/done/failed) or by who it's for.",
    inputSchema: { type: "object", properties: { status: { type: "string" }, to: { type: "string" }, limit: { type: "number" } } } },
  { name: "cancel_task", description: "Cancel an open or claimed task.", inputSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id"] } },
];
var INBOX_TOOLS = new Set(INBOX_TOOL_DEFS.map((t) => t.name));

// ---------- /board: Austin's command board (owner/agent keys) ----------
async function inboxHandleHttp(request, env, url) {
  const p = url.pathname.replace(/\/+$/, "");
  if (p !== "/board" && p !== "/board/api") return null;
  if (p === "/board" && request.method === "GET") return new Response(inboxBoardPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  if (p !== "/board/api" || request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const body = await request.json().catch(() => ({}));
  const auth = await authorizeConnector(env, String(body.key || "").trim());
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (!auth.ok || auth.mode !== "admin") return J({ error: "wrong key" }, 401);
  if (body.action === "list") return J(await runInboxTool("list_tasks", { limit: 100 }, env, "owner"));
  if (body.action === "post") return J(await runInboxTool("post_task", { to: body.to, text: body.text, from: "owner", notify: body.notify !== false }, env, "owner"));
  if (body.action === "cancel") return J(await runInboxTool("cancel_task", { id: body.id, reason: "cancelled on the board" }, env, "owner"));
  return J({ error: "unknown action" }, 400);
}
function inboxBoardPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Agent Board — AMH</title><style>
:root{--bg:#07080b;--card:#11131a;--line:#262a36;--gold:#e8b64c;--gold2:#ffd27a;--ink:#f3f1ea;--mut:#9aa0ad;--ok:#5fd38d;--bad:#ff6b6b;--run:#6fb7ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:720px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:24px;margin:0 0 2px}h1 b{color:var(--gold)}.sub{color:var(--mut);margin:0 0 16px;font-size:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:10px 0}
select,textarea,input{width:100%;background:#0b0d12;color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;font:14px system-ui}textarea{min-height:80px;resize:vertical}
.row{display:flex;gap:8px;margin-bottom:8px}.row>*{flex:1}button{padding:12px 14px;border:0;border-radius:10px;background:linear-gradient(180deg,var(--gold2),var(--gold));color:#1a1405;font-weight:700;font-size:15px;width:100%}
.t{border-top:1px solid var(--line);padding:10px 0}.t:first-child{border-top:0}.meta{font-size:12px;color:var(--mut)}.st{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:2px 8px;border-radius:99px;border:1px solid var(--line)}
.open{color:var(--gold2)}.claimed{color:var(--run)}.done{color:var(--ok)}.failed{color:var(--bad)}.res{white-space:pre-wrap;background:#0b0d12;border-radius:8px;padding:8px;margin-top:6px;font-size:13px}.x{background:none;color:var(--mut);width:auto;padding:0;font-size:12px;font-weight:400;text-decoration:underline}
</style></head><body><main><h1>Agent <b>Board</b></h1><p class="sub">Give any agent a task. Grok and Claude pick theirs up when you tell them “check your inbox”; Jubber picks his up on his own.</p>
<div class="card" id="login"><input id="k" type="password" placeholder="Owner or agent key" autocomplete="off"><div style="height:8px"></div><button onclick="saveKey()">Open board</button></div>
<div id="app" style="display:none"><div class="card"><div class="row"><select id="to"><option value="grok">Grok</option><option value="claude">Claude</option><option value="jubber">Jubber</option><option value="codex">Codex</option><option value="any">Anyone</option></select><select id="nt"><option value="1">Ping my WhatsApp when done</option><option value="0">No ping</option></select></div><textarea id="tx" placeholder="What should they do?"></textarea><div style="height:8px"></div><button onclick="post()">Send task</button></div>
<div class="card"><div class="row" style="margin:0"><div class="meta" id="sum"></div><button class="x" style="text-align:right" onclick="load()">refresh</button></div><div id="list"></div></div></div>
<script>let K='';try{K=localStorage.getItem('amhboard')||''}catch(e){}
const api=async(b)=>{const r=await fetch('/board/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:K,...b})});return r.json()};
const esc=(s)=>String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function saveKey(){K=document.getElementById('k').value.trim();const j=await api({action:'list'});if(j.error){alert(j.error);return}try{localStorage.setItem('amhboard',K)}catch(e){}show(j)}
function show(j){document.getElementById('login').style.display='none';document.getElementById('app').style.display='';const ts=j.tasks||[];const open=ts.filter(t=>t.status==='open'||t.status==='claimed').length;document.getElementById('sum').textContent=open+' open · '+ts.length+' total';
document.getElementById('list').innerHTML=ts.map(t=>'<div class="t"><span class="st '+t.status+'">'+t.status+'</span> <b>'+esc(t.to)+'</b> <span class="meta">from '+esc(t.from)+' · '+new Date(t.created).toLocaleString()+(t.claimed_by?' · by '+esc(t.claimed_by):'')+'</span><div>'+esc(t.text)+'</div>'+(t.result?'<div class="res">'+esc(t.result)+'</div>':'')+((t.status==='open'||t.status==='claimed')?'<button class="x" onclick="cancelT(\\''+t.id+'\\')">cancel</button>':'')+'</div>').join('')||'<p class="meta">No tasks yet.</p>'}
async function load(){const j=await api({action:'list'});if(j.error){document.getElementById('login').style.display='';document.getElementById('app').style.display='none';return}show(j)}
async function post(){const tx=document.getElementById('tx');if(!tx.value.trim())return;const j=await api({action:'post',to:document.getElementById('to').value,text:tx.value.trim(),notify:document.getElementById('nt').value==='1'});if(j.error){alert(j.error);return}tx.value='';load()}
async function cancelT(id){await api({action:'cancel',id});load()}
if(K)load();setInterval(()=>{if(K&&document.visibilityState==='visible')load()},20000)</script></main></body></html>`;
}
