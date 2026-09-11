// Local operator dashboard — opens on localhost, NO login (it's local, not on the
// internet). Reads the operator key from local-stashes/operator.json (or env),
// proxies to the harness internal API server-side so the key never touches the
// browser, and shows the live crew: agents, jobs (newest-first, running pinned,
// done drops below), skills, templates, and how to use them.
//
// Run:  npm run dash   (in agent/)   — then it prints/open a localhost URL.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASH_PORT || 8787);

function operator() {
  const cfg = { url: process.env.HARNESS_URL || "", key: process.env.HARNESS_INTERNAL_KEY || "", actor: process.env.HARNESS_ACTOR || "private-admin" };
  if (!cfg.url || !cfg.key) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(HERE, "..", "local-stashes", "operator.json"), "utf8"));
      cfg.url = cfg.url || s.url || "";
      cfg.key = cfg.key || s.internal_key || "";
      cfg.actor = s.actor || cfg.actor;
    } catch {}
  }
  return cfg;
}
const OP = operator();
if (!OP.url || !OP.key) {
  console.error("No operator credentials. Set HARNESS_URL + HARNESS_INTERNAL_KEY, or create agent/local-stashes/operator.json { url, internal_key }.");
  process.exit(1);
}

const CACHE_MS = Number(process.env.DASH_CACHE_MS || 20000);
const cache = new Map(); // apiPath -> { at, out }
async function proxy(apiPath, method = "GET", body) {
  if (method === "GET" && !body) {
    const hit = cache.get(apiPath);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.out;
    if (hit && hit.pending) return hit.pending;
    const pending = proxyUncached(apiPath, method, body).then((out) => { cache.set(apiPath, { at: Date.now(), out }); return out; })
      .catch((e) => { cache.delete(apiPath); throw e; });
    cache.set(apiPath, { at: 0, out: hit ? hit.out : null, pending });
    return pending;
  }
  return proxyUncached(apiPath, method, body);
}
async function proxyUncached(apiPath, method = "GET", body) {
  const res = await fetch(new URL(apiPath, OP.url), {
    method,
    headers: { "content-type": "application/json", "x-amh-internal-key": OP.key, "x-amh-actor": OP.actor },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AMH WT · Local Agent Dashboard</title>
<style>
:root{--bg:#07130d;--bg2:#0d2015;--ink:#eaf7ee;--muted:#a9c4b2;--line:#244b33;--green:#6ee7a3;--gold:#c8911a;--red:#ff7a7a;--blue:#6fa8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:20px}
.top{display:flex;align-items:center;gap:14px;margin-bottom:6px}
.amh{width:34px;height:38px;flex:0 0 auto;background:#fff;padding:8px 10px;border-radius:12px;box-sizing:content-box}
.wt{height:72px;width:auto;margin-left:auto;border-radius:12px}
.mark{display:inline-grid;place-items:center;width:38px;height:38px;border-radius:11px;background:var(--green);color:#062013;font-weight:900}
h1{font-size:1.15rem;margin:0}.byline{color:var(--muted);font-size:.72rem;letter-spacing:.06em;margin-top:2px}
.sub{color:var(--muted);font-size:.82rem;margin:2px 0 16px}
.foot{margin-top:26px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:.8rem;text-align:center}
.foot a{color:var(--green);text-decoration:none}
.foot .nu{display:inline-flex;align-items:center;gap:8px;font-weight:800;margin-bottom:10px}
.foot .nu svg{width:26px;height:26px;border-radius:7px}
.foot .legal{margin:8px 0}.foot .legal a{color:var(--muted);margin:0 6px}
.amhmark{margin-top:10px;font-family:ui-monospace,Consolas,monospace;font-weight:800;letter-spacing:.08em;color:var(--gold)}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.tab{background:var(--bg2);border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:8px 14px;font-weight:700;cursor:pointer}
.tab.active{background:var(--green);color:#062013}
.pane{display:none}.pane.active{display:block}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
h2{font-size:.95rem;margin:0 0 10px}h3{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:16px 0 8px}
.job{padding:10px 0;border-bottom:1px solid var(--line)}.job:last-child{border:0}
.jobname{font-weight:800}.jobmeta{color:var(--muted);font-size:.8rem}
.bar{height:8px;background:#051008;border-radius:99px;overflow:hidden;margin:6px 0}
.fill{height:100%;background:var(--green);transition:width .5s}
.pill{display:inline-block;font-size:.7rem;font-weight:800;padding:2px 8px;border-radius:99px;background:#123;color:var(--blue);margin-left:6px}
.pill.run{background:#0c2a1a;color:var(--green)}.pill.fail{background:#2a1414;color:var(--red)}.pill.done{background:#1a2233;color:var(--muted)}
.agent{padding:10px 0;border-bottom:1px solid var(--line)}.agent:last-child{border:0}
.agent .role{color:var(--muted);font-size:.82rem}
.how{color:var(--muted);font-size:.85rem}.how code{background:#051008;padding:1px 6px;border-radius:6px;color:var(--green)}
.empty{color:var(--muted)}
.dim{color:var(--muted);font-weight:400;font-size:.8rem}
.today{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.stat{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:12px 16px;min-width:120px}
.stat .n{font-size:1.5rem;font-weight:900;color:var(--green)}.stat .l{color:var(--muted);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:720px){.grid2{grid-template-columns:1fr}}
.caplist{margin:0;padding-left:18px}.caplist li{margin:5px 0;color:var(--ink)}.caplist.no li{color:var(--red)}
.proj{margin:14px 0 6px;font-weight:800;color:var(--gold);font-size:.9rem;border-bottom:1px solid var(--line);padding-bottom:4px}
.params{margin-top:6px;font-size:.8rem;color:var(--muted);background:#051008;border-radius:8px;padding:8px 10px}
.params b{color:var(--ink);font-weight:700}
.amt{float:right;color:var(--green);font-weight:800;font-size:.85rem}
</style></head><body><div class="wrap">
<div class="top">
<svg class="amh" viewBox="0 0 56 64" role="img" aria-label="Artificial Mind Hive"><defs><linearGradient id="ahoney" x1="0" y1="0" x2="56" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#ffd24d"/><stop offset="55%" stop-color="#f5b800"/><stop offset="100%" stop-color="#a87a0c"/></linearGradient><radialGradient id="aglow2" cx="50%" cy="40%" r="60%"><stop offset="0%" stop-color="#fff8e1" stop-opacity="0.65"/><stop offset="100%" stop-color="#f5b800" stop-opacity="0"/></radialGradient></defs><polygon points="28,2 54,17 54,47 28,62 2,47 2,17" fill="url(#ahoney)" stroke="#7c5908" stroke-width="1.25"/><polygon points="28,2 54,17 54,47 28,62 2,47 2,17" fill="url(#aglow2)"/><path d="M18 46 L28 18 L38 46 M22 38 L34 38" stroke="#0e1411" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="28" cy="11" r="2.6" fill="#0e1411"/><circle cx="28" cy="11" r="1.1" fill="#f5b800"/></svg>
<div><h1>Artificial Mind Hive</h1><div class="byline">MCP Agent Console &middot; by Service Pricer LLC&trade;</div></div>
<img class="wt" src="/wt.png" alt="WT walrus">
</div>
<div class="sub" id="sub">connecting…</div>
<div id="today" class="today"></div>
<div class="tabs"><button class="tab active" data-t="jobs">Live jobs</button><button class="tab" data-t="agents">Crew</button><button class="tab" data-t="skills">Skills &amp; templates</button><button class="tab" data-t="how">How it works</button></div>
<div class="pane active" data-p="jobs"><div class="card"><h2>What the crew is doing</h2><div id="jobs"><span class="empty">Loading…</span></div></div></div>
<div class="pane" data-p="agents"><div class="card"><h2>The crew &mdash; who they are and what they have done</h2><div id="agents"><span class="empty">Loading…</span></div></div></div>
<div class="pane" data-p="skills"><div class="card"><h2>Process skills <span class="dim">auto-selected per job, reviewable, never self-applied</span></h2><div id="skills"><span class="empty">Loading…</span></div></div><div class="card"><h2>Templates <span class="dim">the job types the crew can run</span></h2><div id="templates"><span class="empty">Loading…</span></div></div></div>
<div class="pane" data-p="how"><div class="grid2"><div class="card"><h2>What every worker CAN do</h2><ul id="capCan" class="caplist"></ul></div><div class="card"><h2>What it can NEVER do</h2><ul id="capNo" class="caplist no"></ul></div></div><div class="card"><h2>Escalates to a human when…</h2><ul id="capEsc" class="caplist"></ul></div><div class="card"><h2>What the crew has learned <span class="dim">versioned, reviewed lessons</span></h2><div id="learned"><span class="empty">Loading…</span></div></div></div>
<div class="foot">
<a class="nu" href="https://artificialmindhive.com/WalrusTooth" target="_blank" rel="noopener"><svg viewBox="0 0 512 512"><defs><linearGradient id="ng" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd27a"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><rect width="512" height="512" rx="96" fill="#0a0a0f"/><rect x="150" y="120" width="150" height="272" rx="10" fill="none" stroke="url(#ng)" stroke-width="14"/><circle cx="278" cy="262" r="11" fill="url(#ng)"/><text x="330" y="300" font-family="Arial" font-weight="800" font-size="150" fill="url(#ng)">W</text></svg> WT · Walrus Tusk</a>
<div class="legal">
<a href="https://github.com/pain2hustle/cloudflare-ops-mcp" target="_blank" rel="noopener"><svg viewBox="0 0 16 16" width="14" height="14" style="vertical-align:-2px" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg> GitHub / code</a>
<a href="https://artificialmindhive.com/privacy.html" target="_blank" rel="noopener">Privacy</a>
<a href="https://artificialmindhive.com/terms.html" target="_blank" rel="noopener">Terms</a>
<a href="https://artificialmindhive.com/security.html" target="_blank" rel="noopener">Security</a>
<a href="https://artificialmindhive.com/accessibility.html" target="_blank" rel="noopener">Accessibility</a>
</div>
<div><a href="https://artificialmindhive.com" target="_blank" rel="noopener">AMH &mdash; Artificial Mind Hive &middot; Service Pricer LLC&trade;</a></div>
<div class="amhmark">-/\\-\\ M H // WT</div>
</div>
</div>
<script>
const STAGE={job_created:5,job_enqueued:8,safety_preflight:12,job_started:16,crawl_start:22,crawl_complete:38,primary_started:48,primary_completed:66,verifier_started:76,verifier_completed:90,revision_proposed:94,site_healthy:96,site_alert:96,site_recovered:96,job_completed:100,job_failed:100,job_cancelled:100};
const $=id=>document.getElementById(id);
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('active',p.dataset.p===b.dataset.t))});
const esc=s=>String(s==null?'':s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'})[c]);
function pct(job,events){const evs=(events||[]).filter(e=>e.job_id===job.id);let best=5;for(const e of evs){if(STAGE[e.kind]!=null)best=STAGE[e.kind]}if(job.status==='completed'||job.status==='failed'||job.status==='cancelled')return 100;return best}
function stageName(job,events){const evs=(events||[]).filter(e=>e.job_id===job.id);return evs.length?evs[evs.length-1].kind.replace(/_/g,' '):(job.status||'queued')}
function tnum(j){return Date.parse(j.updated_at||j.created_at||0)||0}
function project(j){const p=j.packet||{};const dm=(p.allowed_domains||[])[0];return dm||(p.template_id==='cloudflare_diagnose'?'Cloudflare':'General');}
function aiCalls(j,events){return (events||[]).filter(e=>e.job_id===j.id&&e.kind==='job_completed').reduce((n,e)=>n+Number(e.data&&e.data.ai_calls||0),0);}
async function load(){
  let d;try{const r=await fetch('/d/dashboard');d=await r.json()}catch(e){$('sub').textContent='cannot reach harness: '+e.message;return}
  const u=d.usage||{};const used=u.daily_calls??u.calls??((u.primary_calls||0)+(u.verifier_calls||0));const lim=u.daily_limit??u.limit??8;
  $('sub').textContent='live · auto-refresh 30s · local, no login · model lane: '+(u.profile||'free');
  const jobs=(d.jobs||[]).slice();
  // today stats
  $('today').innerHTML=[['n:'+used+' / '+lim,'AI calls today'],['n:'+(u.zero_ai_jobs??0),'zero-AI jobs'],['n:'+jobs.length,'jobs total'],['n:'+((d.agent_profiles||[]).length),'agents'],['n:'+((d.schedules||[]).length),'schedules']].map(s=>'<div class="stat"><div class="n">'+esc(s[0].slice(2))+'</div><div class="l">'+s[1]+'</div></div>').join('');
  // jobs grouped by project
  const run=jobs.filter(j=>['queued','running'].includes(j.status)).sort((a,b)=>tnum(b)-tnum(a));const done=jobs.filter(j=>!['queued','running'].includes(j.status)).sort((a,b)=>tnum(b)-tnum(a));
  const box=$('jobs');box.innerHTML='';
  const card=(j)=>{const p=pct(j,d.events);const pk=j.packet||{};const cls=j.status==='failed'?'fail':(['completed','cancelled'].includes(j.status)?'done':'run');const calls=aiCalls(j,d.events);const r=j.primary||j.compact;let res='';if(j.compact&&j.compact.checks){res=j.compact.checks.map(c=>(c.healthy?'✓':'✗')+' '+esc(c.url)+' — '+esc(c.detail)).join('<br>');}else if(r&&r.summary){res=esc(r.summary).slice(0,220);}
    return '<div class="job"><div class="jobname">'+esc(pk.agent_name||pk.template_id||'Agent task')+'<span class="pill '+cls+'">'+j.status+'</span>'+(calls?'<span class="amt">'+calls+' AI call'+(calls===1?'':'s')+'</span>':'<span class="amt">0 AI</span>')+'</div><div class="bar"><div class="fill" style="width:'+p+'%"></div></div><div class="jobmeta">'+esc(stageName(j,d.events))+' · '+p+'% · template: '+esc(pk.template_id||'')+'</div><div class="params"><b>objective:</b> '+esc((pk.objective||'').slice(0,200))+'<br><b>domains:</b> '+esc((pk.allowed_domains||[]).join(', ')||'—')+' · <b>urls:</b> '+((pk.urls||[]).length)+' · <b>limits:</b> '+esc(JSON.stringify(pk.limits||{}))+'<br><b>hashes:</b> packet '+esc(String(j.packet_hash||'').slice(0,12))+'… memory '+esc(String(j.memory_hash||'').slice(0,12))+'…'+(res?'<br><b>result:</b> '+res:'')+'</div></div>';};
  const group=(title,arr)=>{if(!arr.length)return;box.insertAdjacentHTML('beforeend','<h3>'+title+'</h3>');const byP={};arr.forEach(j=>{(byP[project(j)]=byP[project(j)]||[]).push(j)});Object.keys(byP).sort().forEach(pr=>{box.insertAdjacentHTML('beforeend','<div class="proj">'+esc(pr)+' · '+byP[pr].length+'</div>');byP[pr].forEach(j=>box.insertAdjacentHTML('beforeend',card(j)))})};
  group('Running now',run);group('Done',done);if(!jobs.length)box.innerHTML='<span class="empty">No jobs yet. Kick one off and it shows here live, grouped by project.</span>';
  // per-agent amounts
  const per={};jobs.forEach(j=>{const n=(j.packet&&j.packet.agent_name)||'—';per[n]=per[n]||{jobs:0,calls:0};per[n].jobs++;per[n].calls+=aiCalls(j,d.events)});
  const ab=$('agents');ab.innerHTML='';(d.agent_profiles||[]).forEach(a=>{const s=per[a.name]||{jobs:0,calls:0};ab.insertAdjacentHTML('beforeend','<div class="agent"><div class="jobname">'+esc(a.name)+(a.system?'<span class="pill">office manager</span>':'')+'<span class="amt">'+s.jobs+' job'+(s.jobs===1?'':'s')+' · '+s.calls+' AI</span></div><div class="role">'+esc(a.role_title||a.template_id||'')+' — '+esc(a.description||'')+'</div></div>')});if(!(d.agent_profiles||[]).length)ab.innerHTML='<span class="empty">No agents yet.</span>';
  // process skills + templates (full detail)
  const cat=d.catalog||{};const sb=$('skills');sb.innerHTML='';(cat.skills||[]).forEach(s=>sb.insertAdjacentHTML('beforeend','<div class="agent"><div class="jobname">'+esc(s.title)+' <span class="pill">'+esc(s.id||'')+'</span></div><div class="role">'+esc(s.purpose)+'</div><div class="how">lane: '+esc(s.lane||'')+' · tools: '+esc((s.tools||[]).join(', ')||'—')+' · auto for: '+esc((s.automatic_for||[]).join(', ')||'—')+' · '+esc(s.folder||'')+'</div></div>'));if(!(cat.skills||[]).length)sb.innerHTML='<span class="empty">No skills.</span>';
  const tb=$('templates');tb.innerHTML='';(cat.templates||[]).forEach(t=>{const calls=t.deterministic?0:(t.verifier?2:1);tb.insertAdjacentHTML('beforeend','<div class="agent"><div class="jobname">'+esc(t.title)+' <span class="pill">'+esc(t.id)+'</span>'+(t.prefersProfile?'<span class="pill fail">needs '+esc(t.prefersProfile)+'</span>':'')+'</div><div class="role">'+esc(t.purpose)+'</div><div class="how">'+calls+' AI call'+(calls===1?'':'s')+'/job · tools: '+esc((t.tools||[]).join(', '))+(t.verifier?' · independent verifier':'')+(t.deterministic?' · zero-AI deterministic':'')+'</div></div>')});
  // how it works — capability tree + learning log
  const ct=cat.capability_tree||{};const fill=(id,arr)=>{const el=$(id);if(!el)return;el.innerHTML=(arr||[]).map(x=>'<li>'+esc(x)+'</li>').join('')||'<li class="dim">—</li>'};
  fill('capCan',ct.can);fill('capNo',ct.cannot);fill('capEsc',ct.escalates_when);
  const lb=$('learned');lb.innerHTML='';(cat.learning_log||[]).forEach(l=>lb.insertAdjacentHTML('beforeend','<div class="agent"><div class="jobname">'+esc(l.added)+' <span class="pill">v'+esc(l.version||'')+'</span></div><div class="role">'+esc(l.meaning)+'</div></div>'));if(!(cat.learning_log||[]).length)lb.innerHTML='<span class="empty">No lessons yet.</span>';
}
load();setInterval(function(){if(!document.hidden)load()},30000);document.addEventListener('visibilitychange',function(){if(!document.hidden)load()});
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/" || req.url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(PAGE);
    }
    if (req.url.startsWith("/d/")) {
      const sub = req.url.slice(3).split("?")[0]; // e.g. "dashboard"
      const map = { dashboard: "/internal/dashboard", jobs: "/internal/jobs", briefing: "/internal/briefing", revisions: "/internal/revisions" };
      const target = map[sub];
      if (!target) { res.writeHead(404); return res.end("{}"); }
      const out = await proxy(target);
      res.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(out.text);
    }
    if (req.url === "/wt.png") {
      try {
        const png = fs.readFileSync(path.join(HERE, "..", "..", "assets", "wt-walrus.png"));
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
        return res.end(png);
      } catch { res.writeHead(404); return res.end(""); }
    }
    res.writeHead(404); res.end("not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error?.message || error) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`\n  AMH WT local dashboard → ${url}`);
  console.log(`  harness: ${OP.url}  ·  no login (local)  ·  Ctrl+C to stop\n`);
  // best-effort open the browser
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(opener[0], opener[1], { stdio: "ignore", detached: true, windowsHide: true }).unref(); } catch {}
});
