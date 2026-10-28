var NP_EDITS = [["var WALO_NOTIFICATION_TRACE_DEF = {name:\"walo_notification_trace\",description:\"Owner-only read-only notification configuration diagnostic. Returns only relay category, tenant-1 key match, sender ID and owner-destination match. No URL/key/hash/phone disclosure, HTTP requests, writes or messages.\",inputSchema:{type:\"object\",additionalProperties:false,properties:{}}};\nasync function traceNotificationConfiguration(env,scope){\n if(scope!==\"owner\"||!env.MCP_KEY)return {error:\"Existing owner authentication required\"};\n const out={relay_category:\"unconfigured\",key_maps_tenant1:null,sender_id:null,owner_destination_matches:null};\n if(env.WA_RELAY_URL)try{\n  const u=new URL(env.WA_RELAY_URL),known={\"api.walohq.com\":\"api_walohq\",\"whatsapp.paycovay.com\":\"whatsapp_paycovay\",\"localops-whatsapp-bridge.austinsdoors.workers.dev\":\"bridge_workers_dev\"};\n  out.relay_category=u.protocol===\"https:\"&&!u.port&&u.pathname===\"/send\"&&!u.username&&!u.password&&!u.search&&!u.hash&&Object.hasOwn(known,u.hostname)?known[u.hostname]:\"other\";\n }catch{out.relay_category=\"invalid\";}\n if(!env.WA_RELAY_KEY||!env.DB)return out;\n try{\n  const digest=await crypto.subtle.digest(\"SHA-256\",new TextEncoder().encode(String(env.WA_RELAY_KEY)));\n  const keyHash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,\"0\")).join(\"\");\n  const row=await env.DB.prepare(\"SELECT CASE WHEN tenant_id='1' THEN 1 ELSE 0 END AS is_tenant1 FROM routes WHERE route_type='relay_key_hash' AND route_value=? LIMIT 1\").bind(keyHash).first();\n  out.key_maps_tenant1=!!row&&row.is_tenant1===1;\n  if(!out.key_maps_tenant1)return out;\n  const t=await env.DB.prepare(\"SELECT t.status,s.wa_phone_number_id FROM tenants t LEFT JOIN tenant_secrets s ON s.tenant_id=t.id WHERE t.id='1'\").first();\n  out.sender_id=t?.status===\"active\"&&typeof t.wa_phone_number_id===\"string\"&&/^\\d{15,20}$/.test(t.wa_phone_number_id)?t.wa_phone_number_id:null;\n  const owner=String(env.WA_OWNER||\"\").replace(/\\D/g,\"\");\n  if(owner){const o=await env.DB.prepare(\"SELECT COUNT(*) AS matches FROM tenant_owners WHERE tenant_id='1' AND role='owner' AND replace(phone,'+','')=?\").bind(owner).first();out.owner_destination_matches=Number(o?.matches)>0;}\n }catch{out.key_maps_tenant1=null;out.sender_id=null;out.owner_destination_matches=null;}\n return out;\n}\n","var WALO_NOTIFICATION_TRACE_DEF = {name:\"walo_notification_trace\",description:\"Owner-only read-only notification configuration diagnostic. Returns only relay category, key classification (unmapped/tenant1/other), sender ID and owner-destination match. No URL/key/hash/phone disclosure, HTTP requests, writes or messages.\",inputSchema:{type:\"object\",additionalProperties:false,properties:{}}};\nasync function traceNotificationConfiguration(env,scope){\n if(scope!==\"owner\"||!env.MCP_KEY)return {error:\"Existing owner authentication required\"};\n const out={relay_category:\"unconfigured\",key_route:null,sender_id:null,owner_destination_matches:null};\n if(env.WA_RELAY_URL)try{\n  const u=new URL(env.WA_RELAY_URL),known={\"api.walohq.com\":\"api_walohq\",\"whatsapp.paycovay.com\":\"whatsapp_paycovay\",\"localops-whatsapp-bridge.austinsdoors.workers.dev\":\"bridge_workers_dev\"};\n  out.relay_category=u.protocol===\"https:\"&&!u.port&&u.pathname===\"/send\"&&!u.username&&!u.password&&!u.search&&!u.hash&&Object.hasOwn(known,u.hostname)?known[u.hostname]:\"other\";\n }catch{out.relay_category=\"invalid\";}\n if(!env.WA_RELAY_KEY||!env.DB)return out;\n try{\n  const digest=await crypto.subtle.digest(\"SHA-256\",new TextEncoder().encode(String(env.WA_RELAY_KEY)));\n  const keyHash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,\"0\")).join(\"\");\n  const row=await env.DB.prepare(\"SELECT CASE WHEN tenant_id='1' THEN 1 ELSE 0 END AS is_tenant1 FROM routes WHERE route_type='relay_key_hash' AND route_value=? LIMIT 1\").bind(keyHash).first();\n  out.key_route=!row?\"unmapped\":row.is_tenant1===1?\"tenant1\":\"other\";\n  if(out.key_route!==\"tenant1\")return out;\n  const t=await env.DB.prepare(\"SELECT t.status,s.wa_phone_number_id FROM tenants t LEFT JOIN tenant_secrets s ON s.tenant_id=t.id WHERE t.id='1'\").first();\n  out.sender_id=t?.status===\"active\"&&typeof t.wa_phone_number_id===\"string\"&&/^\\d{15,20}$/.test(t.wa_phone_number_id)?t.wa_phone_number_id:null;\n  const owner=String(env.WA_OWNER||\"\").replace(/\\D/g,\"\");\n  if(owner){const o=await env.DB.prepare(\"SELECT COUNT(*) AS matches FROM tenant_owners WHERE tenant_id='1' AND role='owner' AND replace(phone,'+','')=?\").bind(owner).first();out.owner_destination_matches=Number(o?.matches)>0;}\n }catch{out.key_route=null;out.sender_id=null;out.owner_destination_matches=null;}\n return out;\n}\n"]];
// Fixed hostname metadata reads only. Existing owner authorizer runs before dispatch.
async function npRelayTargets(env){
 const account='1d5fae607a857fc56cd575763bf8f3bc';
 wdAssert(typeof env.CLOUDFLARE_API_TOKEN_DOORS==='string'&&env.CLOUDFLARE_API_TOKEN_DOORS,'Doors binding required');
 async function get(suffix){
  const r=await fetch('https://api.cloudflare.com/client/v4'+suffix,{method:'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN_DOORS}});
  const j=await r.json().catch(()=>null);wdAssert(r.ok&&j?.success,'Fixed relay metadata read failed');return j.result;
 }
 const rows=[];
 for(const [hostname,zoneName]of [['api.walohq.com','walohq.com'],['whatsapp.paycovay.com','paycovay.com']]){
  const domains=await get('/accounts/'+account+'/workers/domains?hostname='+encodeURIComponent(hostname));
  wdAssert(Array.isArray(domains),'Unexpected hostname metadata');
  const custom=domains.filter(d=>d.hostname===hostname).map(d=>({worker:d.service,enabled:typeof d.enabled==='boolean'?d.enabled:null}));
  const zones=await get('/zones?name='+encodeURIComponent(zoneName)+'&account.id='+account);
  wdAssert(Array.isArray(zones),'Unexpected zone metadata');
  const zone=zones.filter(z=>z.name===zoneName&&z.account?.id===account);wdAssert(zone.length<=1,'Ambiguous relay zone');
  let matches=[];
  if(zone.length){wdAssert(/^[a-f0-9]{32}$/.test(zone[0].id),'Invalid relay zone identity');const routes=await get('/zones/'+zone[0].id+'/workers/routes');wdAssert(Array.isArray(routes),'Unexpected route metadata');matches=routes.filter(r=>npRouteMatches(r.pattern,hostname)).map(r=>({pattern:r.pattern,worker:r.script||null}));}
  const scripts=[...new Set([...custom.filter(x=>x.enabled!==false).map(x=>x.worker),...matches.map(x=>x.worker)].filter(x=>typeof x==='string'))];
  rows.push({hostname,zone_visible:zone.length===1,custom_domains:custom,matching_send_routes:matches,conflict:scripts.length>1,expected_bridge_claimed:scripts.includes('localops-whatsapp-bridge')});
 }
 return {targets:rows,read_only:true,message_sent:false};
}
function npRouteMatches(pattern,hostname){
 if(typeof pattern!=='string')return false;
 const escaped=pattern.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
 const target=pattern.includes('://')?'https://'+hostname+'/send':hostname+'/send';
 try{return new RegExp('^'+escaped+'$','i').test(target);}catch{return false;}
}

// Fixed owner-approved read-only notification probe installation, limited to walo-mcp.
var NP_SCRIPT='walo-mcp',NP_BASE='2d990542-53a8-4aad-9186-abf38f83cdfb',NP_RID='walo-notification-probe-classification-20261028-v2';
async function npLedger(env,b){return wpLedger(env,{...b,rid:NP_RID});}
async function npUpdate(env,patch,release=false){return npLedger(env,{action:'update',patch,release});}
function npPatch(code){
 for(const [find,replacement]of NP_EDITS){wdAssert(code.split(find).length===2,'Approved probe patch anchor mismatch');code=code.replace(find,()=>replacement);}
 return code;
}
async function npSnapshot(env){
 const active=await wdCurrent(env,NP_SCRIPT);wdAssert(arActive(active,NP_BASE),'Notification Worker changed from reviewed base');
 const version=await wdVersion(env,NP_SCRIPT,NP_BASE),settings=await wdApi(env,NP_SCRIPT,'/settings'),body=await wdCode(env,NP_SCRIPT,version);
 wdAssert(!settings.migrations&&body.main_module==='index.js','Unsupported migration or entrypoint');
 const main=body.modules.find(m=>m.name===body.main_module),source=await main.blob.text();
 wdAssert(await arHash(source)==='1ec09e32b618bae6177976a24f05960a7f077eee5cff3f9c006d65ba4d8cce42','Notification source differs from verified release');
 const candidate=npPatch(source),safe={script:NP_SCRIPT,base_version:NP_BASE,base_etag:version.resources.script.etag,main_module:body.main_module,module_hashes:await arModuleHashes(body),settings_sha256:await arHash(arCanon(wdSettings(settings))),resources_sha256:await arHash(arCanon(wdResources(version))),candidate_sha256:await arHash(candidate)};
 wdAssert(arCanon(active)===arCanon(await wdCurrent(env,NP_SCRIPT)),'Concurrent notification deployment');
 return {safe:{...safe,snapshot_sha256:await arHash(arCanon(safe))},version,settings,body,candidate};
}
async function npRollback(env,rec){
 const active=await wdCurrent(env,NP_SCRIPT);
 if(arActive(active,NP_BASE))return {state:'already_at_original'};
 wdAssert(arActive(active,rec.staged_version),'Concurrent version prevents rollback');
 wdAssert(await arHash(arCanon(wdResources(await wdVersion(env,NP_SCRIPT,NP_BASE))))===rec.resources_sha256,'Rollback configuration differs');
 await wdApi(env,NP_SCRIPT,'/deployments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({strategy:'percentage',versions:[{version_id:NP_BASE,percentage:100}]})});
 wdAssert(arActive(await wdCurrent(env,NP_SCRIPT),NP_BASE),'Rollback outcome unconfirmed');
 return {state:'rolled_back',version:NP_BASE};
}
async function runNotificationProbeRepair(args,env){
 wdAssert(args.script===NP_SCRIPT,'Probe installation is limited to walo-mcp');
 if(args.action==='probe_routes')return npRelayTargets(env);
 if(args.action==='probe_inspect'){const s=await npSnapshot(env);return {...s.safe,production_changed:false};}
 const record=(await npLedger(env,{action:'get'})).record;
 if(args.action==='probe_status')return {record:record||null,active:await wdCurrent(env,NP_SCRIPT)};
 wdAssert(args.confirm===true,'Explicit probe installation confirmation required');
 if(args.action==='probe_stage'){
  if(record)return {already_handled:true,record};
  const s=await npSnapshot(env);wdAssert(args.expected_snapshot_sha256===s.safe.snapshot_sha256&&args.candidate_sha256===s.safe.candidate_sha256,'Reviewed probe snapshot drift');
  const claim=await npLedger(env,{action:'claim',jti:NP_RID,sha:s.safe.candidate_sha256,script:NP_SCRIPT,actor:'owner'});
  wdAssert(!claim.error,'Probe ledger refused claim');if(claim.existing)return {already_handled:true,record:claim.existing};
  const form=new FormData(),expected=[];
  const metadata={...s.settings,main_module:s.body.main_module,exports:s.version.resources.script_runtime.exports,keep_assets:true,keep_bindings:['secret_text'],bindings:s.settings.bindings.filter(b=>b.type!=='secret_text'),annotations:{'workers/message':'Approved owner-only read-only notification probe'}};
  form.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}),'metadata.json');
  for(const m of s.body.modules){const blob=m.name===s.body.main_module?new Blob([s.candidate],{type:m.content_type}):m.blob;expected.push({name:m.name,type:m.content_type,bytes:blob.size,sha256:await arHash(await blob.arrayBuffer())});form.append(m.name,blob,m.name);}
  expected.sort((a,b)=>a.name.localeCompare(b.name));const rec={...s.safe,state:'uploading',expected_modules:expected};await npUpdate(env,rec);
  try{
   wdAssert(arActive(await wdCurrent(env,NP_SCRIPT),NP_BASE),'Concurrent version before probe upload');
   wdAssert(await arHash(arCanon(wdSettings(await wdApi(env,NP_SCRIPT,'/settings'))))===s.safe.settings_sha256,'Notification settings drift');
   const next=await wdApi(env,NP_SCRIPT,'/versions?bindings_inherit=strict',{method:'POST',headers:{'if-match':'"'+s.safe.base_etag+'"'},body:form});wdAssert(typeof next.id==='string','Upload has no confirmed version');
   await npUpdate(env,{state:'uploaded_verifying',staged_version:next.id});
   const checked=await wdVerify(env,NP_SCRIPT,{...rec,staged_version:next.id});await npUpdate(env,{state:'staged_verified'},true);return {...checked,production_changed:false};
  }catch(e){await npUpdate(env,{state:'staging_failed_or_uncertain',failure:wdError(e)},true);throw e;}
 }
 wdAssert(args.action==='probe_deploy'&&record?.state==='staged_verified'&&args.candidate_sha256===record.candidate_sha256,'Verified probe stage required');
 await wdVerify(env,NP_SCRIPT,record);
 const rid=NP_RID+'-activate',claim=await wpLedger(env,{action:'claim',rid,jti:rid,sha:record.candidate_sha256,script:NP_SCRIPT,actor:'owner'});
 wdAssert(!claim.error,'Probe activation lock refused');if(claim.existing)return {already_handled:true,record};
 await npUpdate(env,{state:'deploying'});
 try{
  wdAssert(arActive(await wdCurrent(env,NP_SCRIPT),NP_BASE),'Concurrent active version before probe activation');
  const d=await wdApi(env,NP_SCRIPT,'/deployments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({strategy:'percentage',versions:[{version_id:record.staged_version,percentage:100}],annotations:{'workers/message':'Approved owner-only read-only notification probe'}})});
  const checked=await wdVerify(env,NP_SCRIPT,record,false);await npUpdate(env,{state:'live_verified',deployment_id:d.id});await wpLedger(env,{action:'update',rid,patch:{state:'live_verified'},release:true});
  return {...checked,deployment_id:d.id,rollback_version:NP_BASE,probe_run:false,message_sent:false};
 }catch(e){
  await wpLedger(env,{action:'update',rid,patch:{state:'failed_or_uncertain'},release:true});
  let rollback;try{rollback=await npRollback(env,record);}catch{rollback={state:'unconfirmed_or_concurrent_drift'};}
  await npUpdate(env,{state:'deployment_failed_or_uncertain',failure:wdError(e),rollback});return {error:'Probe activation failed',reason:wdError(e),rollback};
 }
}

