import fs from 'node:fs';import vm from 'node:vm';import crypto from 'node:crypto';import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),candidatePath=fs.existsSync(root+'/mcp-candidate.mjs')?root+'/mcp-candidate.mjs':root+'/../live/index.js',bundle=fs.readFileSync(candidatePath,'utf8');
const helpers=bundle.slice(bundle.indexOf('function arCanon('),bundle.indexOf('function arArgs(')),module=bundle.slice(bundle.indexOf('var WC_RESOLVER_HASHES = '),bundle.indexOf('var APIARY_REPAIR_TOOL_DEF = '));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),old='1258784447309850',fresh='1399264479939553';
const source=fs.existsSync(root+'/resolver-fixture.js')?fs.readFileSync(root+'/resolver-fixture.js','utf8'):'';
function harness(){
 const namespace='c'.repeat(32),routeA='a'.repeat(64),routeB='b'.repeat(64),ledger=new Map(),cache=new Map(),calls=[];let writes=0,fail=false,badDB=false,routeCount=2,deny=false,dbFail=false;
 for(const [i,r]of [routeA,routeB].entries())for(const kind of ['tenant','tenantbak']){
  const t={id:'1',owners:['+15550000001'],secrets:{wa_phone_number_id:i===0?old:fresh,private_token:'SECRET_CACHE'},business_name:'Private name'},value=kind==='tenantbak'?{at:1234567890,t}:t;
  cache.set(kind+':relay_key_hash:'+r,{raw:JSON.stringify(value),metadata:{note:'PRIVATE_METADATA'},expiration:Math.floor(Date.now()/1000)+(kind==='tenant'?240:50000)});
 }
 const ctx={crypto:crypto.webcrypto,TextEncoder,TextDecoder,Blob,FormData,Response,URL,structuredClone,console,wpLedger:async(env,b)=>{
  if(b.action==='get')return{record:ledger.get(b.rid)||null};
  if(b.action==='claim'){if(ledger.has(b.rid))return{existing:ledger.get(b.rid)};const rec={state:'accepted'};ledger.set(b.rid,rec);return{claimed:rec};}
  if(b.action==='update'){ledger.set(b.rid,{...ledger.get(b.rid),...b.patch});return{ok:true};}
 }};
 vm.createContext(ctx);vm.runInContext(helpers+module,ctx);
 const actualHash=ctx.arHash;ctx.arHash=async v=>typeof v==='string'&&v===source?'107cb5e80ec7e90f5bae51069b7a9ba52daae2fa77a9f9355d944230197ee402':actualHash(v);
 ctx.wdCurrent=async()=>({id:'deployment',versions:[{version_id:'e0845984-a3b3-462f-860d-bed7d1ea6cf7',percentage:100}]});
 ctx.wdVersion=async()=>({});
 ctx.wdApi=async()=>({bindings:[{name:'DB',type:'d1',id:badDB?'different-db':'203fa727-30e1-4e07-b6a3-0aeefac08412'},{name:'CHAT',type:'kv_namespace',namespace_id:namespace}]});
 ctx.wdCode=async()=>({main_module:'index.js',modules:[{name:'index.js',blob:new Blob([source])}]});
 ctx.fetch=async(url,init={})=>{
  calls.push({url,method:init.method||'GET'});assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/1d5fae607a857fc56cd575763bf8f3bc/'));assert.equal(init.headers.authorization,'Bearer SECRET_PROVIDER');
  const u=new URL(url),p=u.pathname,ok=result=>Response.json({success:true,result});
  if(deny)return Response.json({success:false,errors:[{code:10000,message:'SECRET_PROVIDER'}]},{status:403});
  if(p.endsWith('/query')){
   const b=JSON.parse(init.body);assert.match(b.sql,/^SELECT /);
   if(dbFail)return ok([{success:false,results:[]}]);
   if(b.sql.startsWith('SELECT t.id,t.status'))return ok([{success:true,results:[{id:'1',status:'active',wa_phone_number_id:fresh,owner_verified:1}]}]);
   if(b.sql.startsWith('SELECT phone FROM tenant_owners'))return ok([{success:true,results:[{phone:'+15550000001'}]}]);
   if(b.sql.startsWith('SELECT route_value'))return ok([{success:true,results:[routeA,routeB,...(routeCount>2?['d'.repeat(64)]:[])].map(route_value=>({route_value}))}]);
   assert.equal(b.params[0],'relay_key_hash');assert.ok([routeA,routeB].includes(b.params[1]));return ok([{success:true,results:[{id:'1',status:'active',wa_phone_number_id:fresh,private:'SECRET_DB'}]}]);
  }
  assert.ok(p.includes('/namespaces/'+namespace+'/'));
  if(p.endsWith('/keys')){const key=u.searchParams.get('prefix');assert.ok(cache.has(key));assert.equal(u.searchParams.get('limit'),'2');return ok([{name:key,expiration:cache.get(key).expiration}]);}
  const kind=p.includes('/metadata/')?'metadata':'values',key=decodeURIComponent(p.split('/'+kind+'/')[1]);assert.ok(/^(tenant|tenantbak):relay_key_hash:[ab]{64}$/.test(key));
  if((init.method||'GET')==='GET'){const item=cache.get(key);if(!item)return new Response('',{status:404});return kind==='metadata'?ok(item.metadata):new Response(item.raw);}
  const before=cache.get(key);writes++;
  if(init.method==='DELETE'){cache.delete(key);return ok(null);}
  assert.equal(init.method,'PUT');assert.equal(Number(u.searchParams.get('expiration')),before.expiration);
  const next=init.body.get('value'),metadata=JSON.parse(init.body.get('metadata'));assert.deepEqual(metadata,before.metadata);
  assert.equal(next.replace(fresh,old),before.raw);cache.set(key,{...before,raw:next,metadata});if(fail)throw Error('SECRET_PROVIDER unknown network result');return ok(null);
 };
 const env={CLOUDFLARE_API_TOKEN_DOORS:'SECRET_PROVIDER',RATE_LIMITER_DO:{}},auth={mode:'admin'};
 const call=(action,extra={},who=auth)=>ctx.runWaloDiagnosticRepair({script:'localops-whatsapp-bridge',action,_approved:true,...extra},env,who);
 return {ctx,call,cache,ledger,calls,get writes(){return writes},badDB(){badDB=true},extraRoute(){routeCount=3},deny(){deny=true},dbFail(){dbFail=true},failAfterWrite(){fail=true}};
}
for(const who of [{},{mode:'oauth',connectionId:'x'},{mode:'admin',caller:'walo'},{mode:'admin',connectionId:'x'}])test('cache rejects unauthorized '+JSON.stringify(who),async()=>{const h=harness();assert.ok((await h.call('sender_cache_inspect',{},who)).error);assert.equal(h.calls.length,0)});
for(const extra of [{namespace:'other'},{script:'walo-mcp'},{_approved:false},{key:'arbitrary'},{account:'other'}])test('cache rejects expanded arguments '+JSON.stringify(extra),async()=>{const h=harness();assert.ok((await h.call('sender_cache_inspect',extra)).error);assert.equal(h.writes,0)});
test('inspection is read-only and hides keys/source/secrets',async()=>{const h=harness(),s=await h.call('sender_cache_inspect');assert.ok(s.snapshot_sha256,JSON.stringify(s));assert.deepEqual(JSON.parse(JSON.stringify(s.stale_entries)),['relay-1/current','relay-1/backup']);assert.equal(h.writes,0);assert.equal(h.ledger.size,0);for(const bad of ['SECRET_','PRIVATE_','a'.repeat(64),'b'.repeat(64)])assert.ok(!JSON.stringify(s).includes(bad));});
test('only stale tenant1 fields change; metadata/expiration preserved; duplicate prevented',async()=>{const h=harness(),s=await h.call('sender_cache_inspect'),args={confirm:true,expected_snapshot_sha256:s.snapshot_sha256},before=[...h.cache.values()].map(v=>structuredClone(v));const a=await h.call('sender_cache_apply',args);assert.equal(a.state,'applied',JSON.stringify(a));assert.equal(h.writes,2);assert.deepEqual([...h.cache.values()].slice(2),before.slice(2));const v=await h.call('sender_cache_verify');assert.equal(v.verified,true,JSON.stringify(v));await h.call('sender_cache_apply',args);assert.equal(h.writes,2);assert.ok(!JSON.stringify([...h.ledger.values()]).includes('SECRET_CACHE'));});
test('requires exact live DB binding',async()=>{const h=harness();h.badDB();const r=await h.call('sender_cache_inspect');assert.ok(r.error);assert.equal(h.calls.length,0)});
test('additional tenant routes stop the repair',async()=>{const h=harness();h.extraRoute();assert.ok((await h.call('sender_cache_inspect')).error);assert.equal(h.writes,0)});
test('failed exact D1 resolver query stops the repair',async()=>{const h=harness();h.dbFail();assert.ok((await h.call('sender_cache_inspect')).error);assert.equal(h.writes,0)});
test('foreign cached tenant never changes',async()=>{const h=harness();const e=[...h.cache.values()][0];e.raw=e.raw.replace('"id":"1"','"id":"2"');assert.ok((await h.call('sender_cache_inspect')).error);assert.equal(h.writes,0)});
test('missing owner identity stops the repair',async()=>{const h=harness();const e=[...h.cache.values()][0];e.raw=e.raw.replace('+15550000001','+19999999999');assert.ok((await h.call('sender_cache_inspect')).error);assert.equal(h.writes,0)});
test('snapshot drift fails before mutation',async()=>{const h=harness(),s=await h.call('sender_cache_inspect');[...h.cache.values()][0].raw+=' ';assert.ok((await h.call('sender_cache_apply',{confirm:true,expected_snapshot_sha256:s.snapshot_sha256})).error);assert.equal(h.writes,0)});
test('soon-expiring stale current cache is invalidated, not extended',async()=>{const h=harness();[...h.cache.values()][0].expiration=Math.floor(Date.now()/1000)+40;const s=await h.call('sender_cache_inspect'),r=await h.call('sender_cache_apply',{confirm:true,expected_snapshot_sha256:s.snapshot_sha256});assert.equal(r.state,'applied');assert.equal(r.changes[0].action,'expired_cache_invalidation');assert.equal(h.cache.size,3);assert.equal((await h.call('sender_cache_verify')).verified,true)});
test('uncertain PUT never repeats or reveals exception',async()=>{const h=harness(),s=await h.call('sender_cache_inspect'),a={confirm:true,expected_snapshot_sha256:s.snapshot_sha256};h.failAfterWrite();const r=await h.call('sender_cache_apply',a);assert.ok(r.error);assert.ok(!JSON.stringify(r).includes('SECRET_'));assert.equal(h.writes,1);await h.call('sender_cache_apply',a);assert.equal(h.writes,1);assert.equal((await h.call('sender_cache_verify')).verified,false)});
test('provider denial stops with safe numeric error',async()=>{const h=harness();h.deny();const r=await h.call('sender_cache_inspect');assert.equal(r.reason.status,403);assert.ok(!JSON.stringify(r).includes('SECRET_PROVIDER'));assert.equal(h.writes,0)});
test('confirmation is mandatory for mutation',async()=>{const h=harness();assert.ok((await h.call('sender_cache_apply')).error);assert.equal(h.writes,0)});
test('release bundle matches current verified production snapshot',()=>{assert.equal(hash(bundle),'56fbfca69f7fd3730e3e5122a5f09448916ac896f8cd509c2819be5365be9163');});
