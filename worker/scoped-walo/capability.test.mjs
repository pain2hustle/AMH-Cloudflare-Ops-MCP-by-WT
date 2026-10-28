import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import vm from 'node:vm';import crypto from 'node:crypto';import test from 'node:test';import assert from 'node:assert/strict';
const root=path.dirname(fileURLToPath(import.meta.url)),candidatePath=fs.existsSync(root+'/mcp-candidate.mjs')?root+'/mcp-candidate.mjs':root+'/../live/index.js',bundle=fs.readFileSync(candidatePath,'utf8'),module=fs.readFileSync(root+'/walo-diagnostic-repair.js','utf8');
const helpers=bundle.slice(bundle.indexOf('function arCanon('),bundle.indexOf('function arArgs('))+bundle.slice(bundle.indexOf('async function arModuleHashes('),bundle.indexOf('async function arSnapshot('));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),old='11111111-1111-4111-8111-111111111111',next='22222222-2222-4222-8222-222222222222';
function harness(script='walo-mcp'){
 const ledger=new Map(),calls=[];let active=old,latest=old,mutations=0,failUpload=false,drift=false;
 const settings={compatibility_date:'2026-01-01',compatibility_flags:['nodejs_compat'],bindings:[{name:'TOKEN',type:'secret_text'},{name:'VAR',type:'plain_text',text:'PRIVATE_CONFIGURATION'}]};
 const ctx={crypto:crypto.webcrypto,TextEncoder,TextDecoder,Blob,FormData,Response,structuredClone,console,wpLedger:async(env,b)=>{
  if(b.action==='get')return{record:ledger.get(b.rid)||null};
  if(b.action==='claim'){if(ledger.has(b.rid))return{existing:ledger.get(b.rid)};const rec={state:'accepted',script:b.script,sha:b.sha};ledger.set(b.rid,rec);return{claimed:rec};}
  if(b.action==='update'){ledger.set(b.rid,{...ledger.get(b.rid),...b.patch});return{ok:true};}
 }};
 vm.createContext(ctx);vm.runInContext(helpers+module,ctx);
 const original=ctx.WALO_DIAGNOSTIC_EDITS[script].map(x=>x[0]).join('\n'),sources=new Map([[old,original]]);
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
for(const who of [{},{mode:'oauth',connectionId:'x'},{mode:'admin',caller:'walo'},{mode:'admin',connectionId:'x'}])test('reject unauthorized principal '+JSON.stringify(who),async()=>{const h=harness();assert.ok((await h.call('inspect',{},who)).error);assert.equal(h.calls.length,0)});
for(const args of [{_approved:false},{script:'apiary-bee'},{account:'different'},{code:'arbitrary'},{action:'execute'},{confirm:'true'}])test('reject bad argument '+JSON.stringify(args),async()=>{const h=harness();assert.ok((await h.call('inspect',args)).error);assert.equal(h.calls.length,0)});
for(const script of ['walo-mcp','localops-whatsapp-bridge']){
 test(script+' inspection is read-only and redacted',async()=>{const h=harness(script),s=await h.call('inspect');assert.ok(s.snapshot_sha256);assert.equal(h.mutations,0);assert.equal(h.ledger.size,0);assert.ok(!JSON.stringify(s).includes('SECRET_CREDENTIAL'));assert.ok(!JSON.stringify(s).includes('PRIVATE_CONFIGURATION'));assert.ok(!JSON.stringify(s).includes('async function'));assert.equal(s.rollback_version,old);});
 test(script+' stage/deploy preserves modules/config; duplicate cannot repeat',async()=>{
  const h=harness(script),s=await h.call('inspect'),a={confirm:true,expected_snapshot_sha256:s.snapshot_sha256,candidate_sha256:s.candidate_sha256};
  const staged=await h.call('stage',a);assert.equal(staged.state,'staged_verified',JSON.stringify(staged));assert.equal(h.active,old);assert.equal(h.mutations,1);
  assert.equal((await h.call('stage',a)).already_handled,true);assert.equal(h.mutations,1);
  const live=await h.call('deploy',a);assert.equal(live.state,'live_verified',JSON.stringify(live));assert.equal(h.active,next);assert.equal(h.mutations,2);assert.equal(live.delivery_tested,false);
  await h.call('deploy',a);assert.equal(h.mutations,2);
  const rb=await h.call('rollback',{confirm:true});assert.equal(rb.state,'rolled_back');assert.equal(h.active,old);assert.equal(h.mutations,3);
 });
}
test('stage requires confirmation',async()=>{const h=harness();assert.ok((await h.call('stage')).error);assert.equal(h.mutations,0)});
test('stage refuses snapshot/candidate drift',async()=>{const h=harness();const s=await h.call('inspect');assert.ok((await h.call('stage',{confirm:true,expected_snapshot_sha256:'0'.repeat(64),candidate_sha256:s.candidate_sha256})).error);assert.equal(h.mutations,0)});
test('uncertain upload never retries or reveals exception',async()=>{const h=harness(),s=await h.call('inspect'),a={confirm:true,expected_snapshot_sha256:s.snapshot_sha256,candidate_sha256:s.candidate_sha256};h.setFail();const r=await h.call('stage',a);assert.ok(r.error);assert.ok(!JSON.stringify(r).includes('SECRET_CREDENTIAL'));await h.call('stage',a);assert.equal(h.mutations,1);assert.equal(h.active,old)});
test('settings drift stops deploy',async()=>{const h=harness(),s=await h.call('inspect'),a={confirm:true,expected_snapshot_sha256:s.snapshot_sha256,candidate_sha256:s.candidate_sha256};await h.call('stage',a);h.setDrift();assert.ok((await h.call('deploy',a)).error);assert.equal(h.mutations,1)});
test('concurrent active version prevents rollback',async()=>{const h=harness(),s=await h.call('inspect'),a={confirm:true,expected_snapshot_sha256:s.snapshot_sha256,candidate_sha256:s.candidate_sha256};await h.call('stage',a);await h.call('deploy',a);h.setConcurrent();assert.ok((await h.call('rollback',{confirm:true})).error);assert.equal(h.mutations,2)});
test('missing binding has no fallback',async()=>{const h=harness();delete h.env.CLOUDFLARE_API_TOKEN_DOORS;assert.ok((await h.call('inspect')).error);assert.equal(h.calls.length,0)});
test('patch anchors reject repeated or already-patched source',()=>{const h=harness();const edit=h.ctx.WALO_DIAGNOSTIC_EDITS['walo-mcp'][0];assert.throws(()=>h.ctx.wdPatch('walo-mcp',edit[0]+edit[0]));assert.throws(()=>h.ctx.wdPatch('walo-mcp',edit[1]));});
test('integration preserves exact previous bundle after removing three additions',()=>{
 const candidate=fs.readFileSync(candidatePath,'utf8'),edits=JSON.parse(fs.readFileSync(root+'/repo-edits.json','utf8'));let reverted=candidate;
 for(const edit of edits.reverse()){assert.equal(reverted.split(edit.replace).length,2);reverted=reverted.replace(edit.replace,()=>edit.find);}
 assert.equal(hash(reverted),'2c9e36fa8c985c613f3ba34ab46efa07206b4ac9f3bde1545b44cbe2c5c12451');
});

test('format/comment-only notification differences preserve exact token semantics',()=>{const h=harness(),oldFn=h.ctx.WALO_DIAGNOSTIC_EDITS['walo-mcp'][0][0],formatted=oldFn.replace(/^\s*\/\/.*\n/gm,'').replace(/\n  /g,'\n    ');const patched=h.ctx.wdPatch('walo-mcp',formatted+'\n');assert.equal(patched,h.ctx.WALO_DIAGNOSTIC_EDITS['walo-mcp'][0][1]+'\n');});
test('operator token boundaries are not collapsed',()=>{const h=harness();assert.notEqual(JSON.stringify(h.ctx.wdTokens('a++ +b')),JSON.stringify(h.ctx.wdTokens('a+ ++b')));});
test('changed notification logic is refused and source literals are hashed',async()=>{const h=harness(),oldFn=h.ctx.WALO_DIAGNOSTIC_EDITS['walo-mcp'][0][0],changed=oldFn.replace('WA_OWNER','DIFFERENT_OWNER').replace('"POST"','"SECRET_UNKNOWN_LITERAL"')+'\n';assert.throws(()=>h.ctx.wdPatch('walo-mcp',changed));const result=await h.ctx.wdNotifyComparison(changed);assert.equal(result.same_tokens,false);assert.ok(!JSON.stringify(result).includes('SECRET_UNKNOWN_LITERAL'));assert.ok(result.function_sha256);});
