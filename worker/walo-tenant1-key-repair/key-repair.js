// One owner-approved credential correction. Plaintext exists only in request memory and the Worker secret.
var KR_RID='walo-tenant1-relay-key-20261029-v1',KR_DB='203fa727-30e1-4e07-b6a3-0aeefac08412';
var KR_BASES={'walo-mcp':{version:'fec6935a-634e-457c-8905-685b32fe830d',sha:'c2c89cbb6132875c3ee6fde49b9e76ca4f2c1f5b9c9fa2e84749b43468cedd8d'},'localops-whatsapp-bridge':{version:'e0845984-a3b3-462f-860d-bed7d1ea6cf7',sha:'107cb5e80ec7e90f5bae51069b7a9ba52daae2fa77a9f9355d944230197ee402'}};
async function krLedger(env,b){return wpLedger(env,{...b,rid:KR_RID});}
async function krUpdate(env,patch,release=false){return krLedger(env,{action:'update',patch,release});}
function krPublic(r){if(!r)return null;return {state:r.state,base_version:r.base_version,staged_version:r.staged_version||null,deployment_id:r.deployment_id||null,route_added:r.route_added===true,rollback_version:r.base_version,reason:r.failure||null,message_sent:false};}
async function krSnapshot(env){
 const all={};
 for(const [script,pin]of Object.entries(KR_BASES)){
  const active=await wdCurrent(env,script);wdAssert(arActive(active,pin.version),'Key repair Worker version drift');
  const version=await wdVersion(env,script,pin.version),settings=await wdApi(env,script,'/settings');
  const db=settings.bindings?.filter(b=>b.name==='DB'),vdb=version.resources?.bindings?.filter(b=>b.name==='DB');
  wdAssert(db?.length===1&&db[0].type==='d1'&&(db[0].id||db[0].database_id)===KR_DB,'Key repair current DB identity mismatch');
  wdAssert(vdb?.length===1&&vdb[0].type==='d1'&&(vdb[0].id||vdb[0].database_id)===KR_DB,'Key repair version DB identity mismatch');
  wdAssert(!settings.migrations,'Key repair refuses migrations');
  const body=await wdCode(env,script,version);wdAssert(body.main_module==='index.js','Key repair entrypoint mismatch');
  wdAssert(await arHash(await body.modules.find(m=>m.name===body.main_module).blob.arrayBuffer())===pin.sha,'Key repair source drift');
  const safe={base_version:pin.version,base_etag:version.resources.script.etag,main_module:body.main_module,settings_sha256:await arHash(arCanon(wdSettings(settings))),resources_sha256:await arHash(arCanon(wdResources(version))),expected_modules:await arModuleHashes(body)};
  wdAssert(arActive(await wdCurrent(env,script),pin.version),'Concurrent key repair deployment');all[script]={safe,version,settings,body};
 }
 const binding=all['walo-mcp'].settings.bindings.filter(b=>b.name==='WA_RELAY_KEY');wdAssert(binding.length===1&&binding[0].type==='secret_text','Existing notification secret binding required');
 const tenant=await wcQuery(env,"SELECT t.status,s.wa_phone_number_id FROM tenants t JOIN tenant_secrets s ON s.tenant_id=t.id WHERE t.id='1'");
 wdAssert(tenant.length===1&&tenant[0].status==='active'&&tenant[0].wa_phone_number_id==='1399264479939553','Key repair tenant sender mismatch');
 const rows=await wcQuery(env,"SELECT route_value FROM routes WHERE tenant_id='1' AND route_type='relay_key_hash' ORDER BY route_value");
 wdAssert(rows.length===2&&rows.every(r=>/^[a-f0-9]{64}$/.test(r.route_value)),'Key repair tenant route baseline changed');
 const safe={workers:Object.fromEntries(Object.entries(all).map(([k,v])=>[k,v.safe])),database_id:KR_DB,both_database_identities_verified:true,tenant_id:'1',sender_id:'1399264479939553',existing_tenant1_route_count:rows.length,tenant1_route_set_digest:await arHash(arCanon(rows))};
 return {all,safe:{...safe,snapshot_sha256:await arHash(arCanon(safe))}};
}
async function krGuard(env,s){for(const [script,v]of Object.entries(s.all)){wdAssert(arActive(await wdCurrent(env,script),v.safe.base_version),'Concurrent key repair Worker change');wdAssert(await arHash(arCanon(wdSettings(await wdApi(env,script,'/settings'))))===v.safe.settings_sha256,'Key repair binding drift');}}
async function runTenant1KeyRepair(args,env){
 wdAssert(args.script==='walo-mcp','Key repair limited to notification Worker');
 if(args.action==='key_inspect'){const s=await krSnapshot(env);return {...s.safe,production_changed:false};}
 const record=(await krLedger(env,{action:'get'})).record;
 if(args.action==='key_status')return {record:krPublic(record),active:await wdCurrent(env,'walo-mcp')};
 wdAssert(args.action==='key_apply'&&args.confirm===true,'Explicit tenant1 key confirmation required');
 if(record)return {already_handled:true,record:krPublic(record)};
 const s=await krSnapshot(env);wdAssert(args.expected_snapshot_sha256===s.safe.snapshot_sha256,'Reviewed key repair snapshot changed');
 const claim=await krLedger(env,{action:'claim',jti:KR_RID,sha:s.safe.snapshot_sha256,script:'walo-mcp',actor:'owner'});wdAssert(!claim.error,'Key repair lock refused');if(claim.existing)return{already_handled:true,record:krPublic(claim.existing)};
 const w=s.all['walo-mcp'],rec={...w.safe,state:'claimed',route_added:false,bridge_version:KR_BASES['localops-whatsapp-bridge'].version};await krUpdate(env,rec);
 let key=null,staged=null;
 try{
  await krGuard(env,s);
  const random=crypto.getRandomValues(new Uint8Array(32));key=[...random].map(b=>b.toString(16).padStart(2,'0')).join('');random.fill(0);
  const digest=await arHash(key);await krUpdate(env,{state:'registering_hash',key_hash:digest});
  const inserted=await wcQuery(env,"INSERT INTO routes(route_type,route_value,tenant_id) SELECT 'relay_key_hash',?,'1' WHERE EXISTS(SELECT 1 FROM tenants t JOIN tenant_secrets s ON s.tenant_id=t.id WHERE t.id='1' AND t.status='active' AND s.wa_phone_number_id='1399264479939553') AND NOT EXISTS(SELECT 1 FROM routes WHERE route_type='relay_key_hash' AND route_value=?) RETURNING tenant_id",[digest,digest]);
  wdAssert(inserted.length===1&&inserted[0].tenant_id==='1','Dedicated key registration not confirmed');await krUpdate(env,{state:'hash_registered',route_added:true});
  const check=await wcQuery(env,"SELECT CASE WHEN tenant_id='1' THEN 1 ELSE 0 END AS is_tenant1 FROM routes WHERE route_type='relay_key_hash' AND route_value=?",[digest]);wdAssert(check.length===1&&check[0].is_tenant1===1,'Dedicated key tenant verification failed');
  const metadata={...w.settings,main_module:w.body.main_module,exports:w.version.resources.script_runtime.exports,keep_assets:true,keep_bindings:['secret_text'],bindings:[...w.settings.bindings.filter(b=>b.type!=='secret_text'),{name:'WA_RELAY_KEY',type:'secret_text',text:key}],annotations:{'workers/message':'Owner-approved dedicated tenant1 notification relay credential'}};
  const form=new FormData();form.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}),'metadata.json');for(const m of w.body.modules)form.append(m.name,m.blob,m.name);
  await krGuard(env,s);await krUpdate(env,{state:'secret_uploading'});
  const next=await wdApi(env,'walo-mcp','/versions?bindings_inherit=strict',{method:'POST',headers:{'if-match':'"'+w.safe.base_etag+'"'},body:form});key=null;
  wdAssert(typeof next.id==='string','Dedicated secret upload has no confirmed version');staged=next.id;await krUpdate(env,{state:'staged_verifying',staged_version:staged});
  await wdVerify(env,'walo-mcp',{...rec,staged_version:staged});
  wdAssert(arActive(await wdCurrent(env,'localops-whatsapp-bridge'),rec.bridge_version),'Bridge changed before key activation');
  wdAssert(await arHash(arCanon(wdSettings(await wdApi(env,'localops-whatsapp-bridge','/settings'))))===s.all['localops-whatsapp-bridge'].safe.settings_sha256,'Bridge settings changed before key activation');
  await krUpdate(env,{state:'activating'});
  const deployed=await wdApi(env,'walo-mcp','/deployments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({strategy:'percentage',versions:[{version_id:staged,percentage:100}],annotations:{'workers/message':'Owner-approved tenant1 notification credential correction'}})});
  await wdVerify(env,'walo-mcp',{...rec,staged_version:staged},false);
  await krUpdate(env,{state:'live_verified',deployment_id:deployed.id},true);
  return {state:'live_verified',version:staged,deployment_id:deployed.id,rollback_version:rec.base_version,tenant_id:'1',route_added:true,source_bindings_runtime_preserved:true,secret_values_returned:false,message_sent:false,requires_runtime_trace:true};
 }catch(e){key=null;await krUpdate(env,{state:'failed_or_uncertain',failure:wdError(e)},true);return {error:'Dedicated key repair stopped',reason:wdError(e),record:krPublic((await krLedger(env,{action:'get'})).record),message_sent:false,do_not_retry:true};}
}
