import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import vm from 'node:vm';import crypto from 'node:crypto';import test from 'node:test';import assert from 'node:assert/strict';
const root=path.dirname(fileURLToPath(import.meta.url)),candidatePath=fs.existsSync(root+'/mcp-candidate.mjs')?root+'/mcp-candidate.mjs':root+'/../live/index.js',bundle=fs.readFileSync(candidatePath,'utf8'),module=bundle.slice(bundle.indexOf('var NP_EDITS = '),bundle.indexOf('var APIARY_REPAIR_TOOL_DEF = '));
const helpers=bundle.slice(bundle.indexOf('function arCanon('),bundle.indexOf('function arArgs('))+bundle.slice(bundle.indexOf('async function arModuleHashes('),bundle.indexOf('async function arSnapshot('));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),old='2d990542-53a8-4aad-9186-abf38f83cdfb',next='22222222-2222-4222-8222-222222222222';
function harness(script='walo-mcp'){
 const ledger=new Map(),calls=[];let active=old,latest=old,mutations=0,failUpload=false,drift=false;
 const settings={compatibility_date:'2026-01-01',compatibility_flags:['nodejs_compat'],bindings:[{name:'TOKEN',type:'secret_text'},{name:'VAR',type:'plain_text',text:'PRIVATE_CONFIGURATION'}]};
 const ctx={crypto:crypto.webcrypto,TextEncoder,TextDecoder,Blob,FormData,Response,structuredClone,console,wpLedger:async(env,b)=>{
  if(b.action==='get')return{record:ledger.get(b.rid)||null};
  if(b.action==='claim'){if(ledger.has(b.rid))return{existing:ledger.get(b.rid)};const rec={state:'accepted',script:b.script,sha:b.sha};ledger.set(b.rid,rec);return{claimed:rec};}
  if(b.action==='update'){ledger.set(b.rid,{...ledger.get(b.rid),...b.patch});return{ok:true};}
 }};
 vm.createContext(ctx);vm.runInContext(helpers+module,ctx);
 const original=ctx.NP_EDITS.map(x=>x[0]).join('\n'),sources=new Map([[old,original]]);
 const realHash=ctx.arHash;ctx.arHash=async v=>v===original?'1ec09e32b618bae6177976a24f05960a7f077eee5cff3f9c006d65ba4d8cce42':realHash(v);
 const resource=id=>({script:{etag:hash(sources.get(id))},script_runtime:{compatibility_date:'2026-01-01',exports:['default']},bindings:settings.bindings.map(b=>({...b}))});
 ctx.fetch=async(url,init={})=>{
  calls.push({url,method:init.method||'GET'});assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/1d5fae607a857fc56cd575763bf8f3bc/workers/scripts/'+script+'/'));
  assert.equal(init.headers.authorization,'Bearer SECRET_CREDENTIAL');
  const p=new URL(url).pathname.split('/scripts/'+script)[1],method=init.method||'GET';
  const ok=result=>Response.json({success:true,result});
  if(method==='POST'){mutations++;if(p==='/versions'){
   const metadata=JSON.parse(await init.body.get('metadata').text());
   assert.deepEqual(metadata.keep_bindings,['secret_text']);assert.equal(metadata.bindings.some(b=>b.type==='secret_text'),false);assert.deepEqual(metadata.exports,['default']);
   sources.set(next,await init.body.get('index.js').text());assert.equal(await init.body.get('support.js').text(),'untouched');
   latest=next;if(failUpload)throw Error('SECRET_CREDENTIAL private network error');return ok({id:next});
  }if(p==='/deployments'){const b=JSON.parse(init.body);active=b.versions[0].version_id;return ok({id:'deployment-'+active});}assert.fail('Unexpected mutation');}
  if(p==='/deployments')return ok({deployments:[{id:'deployment-'+active,versions:[{version_id:active,percentage:100}]}]});
  if(p==='/settings')return ok(drift?{...settings,compatibility_date:'2026-02-01'}:settings);
  if(p.startsWith('/versions/'))return ok({id:p.slice(10),resources:resource(p.slice(10))});
  if(p==='/content/v2'){const f=new FormData();f.append('index.js',new Blob([sources.get(latest)],{type:'application/javascript+module'}),'index.js');f.append('support.js',new Blob(['untouched'],{type:'application/javascript+module'}),'support.js');const r=new Response(f);r.headers.set('etag','"'+hash(sources.get(latest))+'"');r.headers.set('cf-entrypoint','index.js');return r;}
  assert.fail('Unexpected endpoint '+p);
 };
 const env={CLOUDFLARE_API_TOKEN_DOORS:'SECRET_CREDENTIAL',RATE_LIMITER_DO:{}},auth={mode:'admin'};
 const call=(action,extra={},who=auth)=>ctx.runWaloDiagnosticRepair({script,action,_approved:true,...extra},env,who);
 return {call,ctx,calls,ledger,env,auth,get mutations(){return mutations},get active(){return active},setFail(){failUpload=true},setDrift(){drift=true},setConcurrent(){active='33333333-3333-4333-8333-333333333333'}};
}

for(const who of [{},{mode:'oauth',connectionId:'x'},{mode:'admin',caller:'walo'}])test('probe principal guard '+JSON.stringify(who),async()=>{const h=harness();assert.ok((await h.call('probe_inspect',{},who)).error);assert.equal(h.calls.length,0)});
test('probe wrong worker rejected',async()=>{const h=harness('localops-whatsapp-bridge');assert.ok((await h.call('probe_inspect')).error);assert.equal(h.calls.length,0)});
test('probe inspect read-only',async()=>{const h=harness(),s=await h.call('probe_inspect');assert.ok(s.snapshot_sha256,JSON.stringify(s));assert.equal(h.mutations,0)});
test('probe stage and deploy preserve modules/config; duplicate blocked',async()=>{const h=harness(),s=await h.call('probe_inspect'),a={confirm:true,expected_snapshot_sha256:s.snapshot_sha256,candidate_sha256:s.candidate_sha256};const stage=await h.call('probe_stage',a);assert.equal(stage.state,'staged_verified',JSON.stringify(stage));assert.equal(h.active,old);assert.equal(h.mutations,1);assert.equal((await h.call('probe_stage',a)).already_handled,true);const live=await h.call('probe_deploy',a);assert.equal(live.state,'live_verified',JSON.stringify(live));assert.equal(live.message_sent,false);assert.equal(h.mutations,2);await h.call('probe_deploy',a);assert.equal(h.mutations,2)});
test('probe source drift denied',async()=>{const h=harness();h.ctx.arHash=async()=> 'different';assert.ok((await h.call('probe_inspect')).error);assert.equal(h.mutations,0)});
test('probe requires action confirmation',async()=>{const h=harness();assert.ok((await h.call('probe_stage')).error);assert.equal(h.mutations,0)});
test('probe uncertain upload never repeats',async()=>{const h=harness(),s=await h.call('probe_inspect'),a={confirm:true,expected_snapshot_sha256:s.snapshot_sha256,candidate_sha256:s.candidate_sha256};h.setFail();const v=await h.call('probe_stage',a);assert.ok(v.error);assert.doesNotMatch(JSON.stringify(v),/SECRET_CREDENTIAL/);await h.call('probe_stage',a);assert.equal(h.mutations,1)});
test('probe config drift stops activation',async()=>{const h=harness(),s=await h.call('probe_inspect'),a={confirm:true,expected_snapshot_sha256:s.snapshot_sha256,candidate_sha256:s.candidate_sha256};await h.call('probe_stage',a);h.setDrift();assert.ok((await h.call('probe_deploy',a)).error);assert.equal(h.mutations,1)});
test('probe concurrent deployment stops activation',async()=>{const h=harness(),s=await h.call('probe_inspect'),a={confirm:true,expected_snapshot_sha256:s.snapshot_sha256,candidate_sha256:s.candidate_sha256};await h.call('probe_stage',a);h.setConcurrent();assert.ok((await h.call('probe_deploy',a)).error);assert.equal(h.mutations,1)});
