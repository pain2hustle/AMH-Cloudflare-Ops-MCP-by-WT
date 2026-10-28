var WC_RESOLVER_HASHES = {"resolveTenant":"f2185ee7da530cba712e4247f8f9e1dd2fb5b5ff95830533b886e220b5f3a5ec","resolveTenantByRelayKey":"55dc279b9f88e54f3a268bd11ad570b6fbfc3227ed1092c611439a6a814282cc"};
var WC_RESOLVE_SQL = "SELECT t.id,t.slug,t.business_name,t.status,t.plan,t.timezone,t.voice,\n              t.hours_json,t.config_json,\n              s.indexnow_host,s.indexnow_key,s.wa_phone_number_id,s.wa_display_number,\n              s.lead_token,s.relay_key_hash\n         FROM routes r\n         JOIN tenants t ON t.id = r.tenant_id\n         LEFT JOIN tenant_secrets s ON s.tenant_id = t.id\n        WHERE r.route_type = ? AND r.route_value = ? LIMIT 1";
// Approved tenant-1-only sender-cache correction. No credentials, messages or arbitrary KV access.
var WC_ACCOUNT='1d5fae607a857fc56cd575763bf8f3bc';
var WC_DB='203fa727-30e1-4e07-b6a3-0aeefac08412';
var WC_SCRIPT='localops-whatsapp-bridge';
var WC_VERSION='e0845984-a3b3-462f-860d-bed7d1ea6cf7';
var WC_OLD='1258784447309850',WC_NEW='1399264479939553';
var WC_RID='walo-tenant1-sender-cache-20261028-v1';
function wcIdentity(t,owners){return t&&String(t.id)==='1'&&Array.isArray(t.owners)&&Array.isArray(owners)&&owners.length>0&&arCanon([...new Set(t.owners.map(x=>String(x).replace(/\D/g,'')))].sort())===arCanon(owners)&&t.secrets&&typeof t.secrets==='object';}
async function wcApi(env,path,init={},raw=false){
 const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+WC_ACCOUNT+path,{...init,headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN_DOORS,...init.headers}});
 if(raw&&r.status===404)return null;
 if(raw&&r.ok){const text=await r.text();wdAssert(new TextEncoder().encode(text).length<=262144,'Target cache exceeds safe size');return text;}
 const j=await r.json().catch(()=>null);
 if(!r.ok||!j?.success){const e=new Error('Scoped cache provider operation failed');e.safe={status:r.status,codes:j?.errors?.map(x=>x.code).filter(Number.isSafeInteger)||[]};throw e;}
 return j.result;
}
async function wcQuery(env,sql,params=[]){
 const rows=await wcApi(env,'/d1/database/'+WC_DB+'/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql,params})});
 wdAssert(Array.isArray(rows)&&rows.length===1&&rows[0].success!==false&&Array.isArray(rows[0].results),'Tenant database query failed');
 return rows[0].results;
}
async function wcBinding(env){
 const active=await wdCurrent(env,WC_SCRIPT);wdAssert(arActive(active,WC_VERSION),'Bridge version changed; cache resolver must be reviewed');
 const settings=await wdApi(env,WC_SCRIPT,'/settings');
 const db=settings.bindings?.filter(b=>b.name==='DB'),chat=settings.bindings?.filter(b=>b.name==='CHAT');
 wdAssert(db?.length===1&&db[0].type==='d1'&&(db[0].id||db[0].database_id)===WC_DB,'Live bridge DB binding differs from approved localops database');
 wdAssert(chat?.length===1&&chat[0].type==='kv_namespace'&&/^[a-f0-9]{32}$/.test(chat[0].namespace_id),'Live CHAT binding is unavailable or ambiguous');
 const version=await wdVersion(env,WC_SCRIPT,WC_VERSION),body=await wdCode(env,WC_SCRIPT,version);
 wdAssert(body.main_module==='index.js','Unexpected bridge entrypoint');
 const source=await body.modules.find(m=>m.name===body.main_module).blob.text();
 wdAssert(await arHash(source)==='107cb5e80ec7e90f5bae51069b7a9ba52daae2fa77a9f9355d944230197ee402','Bridge source drift');
 const resolver={};
 for(const [name,expected]of Object.entries(WC_RESOLVER_HASHES)){
  const start=source.indexOf('async function '+name+'('),end=source.indexOf('\n}\n',start);
  wdAssert(start>=0&&end>start&&source.indexOf('async function '+name+'(',start+1)<0,'Resolver boundary changed');
  const digest=await arHash(source.slice(start,end+2));resolver[name]=digest===expected;
 }
 wdAssert(Object.values(resolver).every(Boolean),'Live tenant resolution differs from reviewed source');
 return {namespace:chat[0].namespace_id,active,settings_sha256:await arHash(arCanon(wdSettings(settings))),resolver_verified:true};
}
async function wcRoutes(env){
 const t=await wcQuery(env,"SELECT t.id,t.status,s.wa_phone_number_id FROM tenants t JOIN tenant_secrets s ON s.tenant_id=t.id WHERE t.id='1'");
 wdAssert(t.length===1&&t[0].status==='active'&&t[0].wa_phone_number_id===WC_NEW,'Authoritative tenant or replacement sender mismatch');
 const ownerRows=await wcQuery(env,"SELECT phone FROM tenant_owners WHERE tenant_id='1' AND role='owner'");
 const owners=[...new Set(ownerRows.map(x=>String(x.phone||'').replace(/\D/g,'')))].sort();wdAssert(owners.length>0&&owners.every(x=>/^\d{8,15}$/.test(x)),'Authoritative owner identity unavailable');
 const routes=await wcQuery(env,"SELECT route_value FROM routes WHERE tenant_id='1' AND route_type='relay_key_hash' ORDER BY route_value");
 wdAssert(routes.length===2&&routes.every(x=>/^[a-f0-9]{64}$/.test(x.route_value))&&new Set(routes.map(x=>x.route_value)).size===2,'Tenant relay route set changed');
 const safeRows=[];
 for(const r of routes){
  const row=await wcQuery(env,WC_RESOLVE_SQL,['relay_key_hash',r.route_value]);
  wdAssert(row.length===1&&String(row[0].id)==='1'&&row[0].status==='active'&&row[0].wa_phone_number_id===WC_NEW,'Live resolver query did not return the approved tenant and sender');
  safeRows.push({tenant_id:'1',sender_id:row[0].wa_phone_number_id,active:true});
 }
 return {routes:routes.map(r=>r.route_value),owners,d1_resolution:safeRows};
}
async function wcRead(env,namespace,key,handle,kind,owners){
 wdAssert(/^(tenant|tenantbak):relay_key_hash:[a-f0-9]{64}$/.test(key),'Invalid derived cache key');
 const base='/storage/kv/namespaces/'+namespace,raw=await wcApi(env,base+'/values/'+encodeURIComponent(key),{},true);
 if(raw===null)return {key,kind,handle,raw:null,safe:{handle,kind,exists:false}};
 let value;try{value=JSON.parse(raw);}catch{wdAssert(false,'Target cache is not valid JSON');}
 const t=kind==='backup'?value.t:value;wdAssert(wcIdentity(t,owners),'Target cache does not belong to the verified tenant owner');
 wdAssert([WC_OLD,WC_NEW].includes(t.secrets.wa_phone_number_id),'Unexpected cached sender; no correction permitted');
 const list=await wcApi(env,base+'/keys?prefix='+encodeURIComponent(key)+'&limit=2');
 wdAssert(Array.isArray(list),'Cache expiration metadata unavailable');
 const exact=list.filter(x=>x.name===key);wdAssert(exact.length===1,'Exact cache expiration metadata unavailable');
 const expiration=exact[0].expiration===undefined?null:Number(exact[0].expiration);
 wdAssert(expiration===null||Number.isSafeInteger(expiration),'Invalid cache expiration');
 const metadata=await wcApi(env,base+'/metadata/'+encodeURIComponent(key));
 return {key,kind,handle,raw,value,metadata,expiration,owners,safe:{handle,kind,exists:true,tenant_id:'1',owner_verified:true,sender_id:t.secrets.wa_phone_number_id,backup_timestamp:kind==='backup'&&Number.isSafeInteger(value.at)?value.at:null,expiration,content_sha256:await arHash(raw),metadata_sha256:await arHash(arCanon(metadata))}};
}
async function wcSnapshot(env){
 const binding=await wcBinding(env),r=await wcRoutes(env),entries=[];
 for(let i=0;i<r.routes.length;i++)for(const kind of ['current','backup']){
  const key=(kind==='backup'?'tenantbak:':'tenant:')+'relay_key_hash:'+r.routes[i];
  entries.push(await wcRead(env,binding.namespace,key,'relay-'+(i+1)+'/'+kind,kind,r.owners));
 }
 const safe={account:WC_ACCOUNT,script:WC_SCRIPT,tenant_id:'1',db_binding_verified:true,db_id:WC_DB,bridge_version:WC_VERSION,resolver_verified:true,d1_resolution:r.d1_resolution,settings_sha256:binding.settings_sha256,route_set_sha256:await arHash(arCanon(r.routes)),cache_entries:entries.map(e=>e.safe)};
 wdAssert(arActive(await wdCurrent(env,WC_SCRIPT),WC_VERSION),'Bridge changed during cache inspection');
 return {binding,entries,owners:r.owners,safe:{...safe,snapshot_sha256:await arHash(arCanon(safe)),stale_entries:entries.filter(e=>e.safe.sender_id===WC_OLD).map(e=>e.handle)}};
}
function wcReplace(entry){
 wdAssert(entry.raw!==null&&entry.safe.sender_id===WC_OLD,'Only proven stale cache entries may change');
 const pattern=new RegExp('("wa_phone_number_id"\\s*:\\s*")'+WC_OLD+'(")','g');
 wdAssert([...entry.raw.matchAll(pattern)].length===1,'Sender field is not uniquely represented');
 const next=entry.raw.replace(pattern,(_,a,b)=>a+WC_NEW+b),v=JSON.parse(next),t=entry.kind==='backup'?v.t:v;
 wdAssert(wcIdentity(t,entry.owners)&&t.secrets.wa_phone_number_id===WC_NEW,'Corrected cache identity mismatch');
 const reverted=next.replace(new RegExp('("wa_phone_number_id"\\s*:\\s*")'+WC_NEW+'(")'),(_,a,b)=>a+WC_OLD+b);
 wdAssert(reverted===entry.raw,'Cache changes exceed the single sender field');
 return next;
}
async function wcLedger(env,b){return wpLedger(env,{...b,rid:WC_RID});}
async function wcRun(args,env){
 wdAssert(args.script===WC_SCRIPT,'Sender cache repair is restricted to the bridge');
 const record=(await wcLedger(env,{action:'get'})).record;
 if(args.action==='sender_cache_inspect'){const s=await wcSnapshot(env);return {...s.safe,production_changed:false};}
 if(args.action==='sender_cache_verify'){
  const s=await wcSnapshot(env),done=(record?.changes||[]).every(c=>{
   const e=s.entries.find(e=>e.handle===c.handle);
   return e&&(c.action==='expired_cache_invalidation'?e.raw===null:e.safe.content_sha256===c.after_sha256||e.raw===null&&c.expiration!==null&&c.expiration<=Math.floor(Date.now()/1000));
  });
  return {state:record?.state||'not_applied',record:record||null,verified:!!record&&record.state==='applied'&&done,snapshot:s.safe,delivery_tested:false};
 }
 wdAssert(args.action==='sender_cache_apply'&&args.confirm===true&&args.expected_snapshot_sha256,'Confirmed inspection required');
 if(record)return {already_handled:true,record};
 const s=await wcSnapshot(env);wdAssert(s.safe.snapshot_sha256===args.expected_snapshot_sha256,'Target cache snapshot drift');
 const stale=s.entries.filter(e=>e.safe.sender_id===WC_OLD);
 if(!stale.length)return {state:'nothing_to_repair',snapshot:s.safe,production_changed:false};
 const claim=await wcLedger(env,{action:'claim',jti:WC_RID,sha:s.safe.snapshot_sha256,script:WC_SCRIPT,actor:'owner'});
 wdAssert(!claim.error,'Sender cache repair ledger refused claim');
 if(claim.existing)return {already_handled:true,record:claim.existing};
 const changes=[];await wcLedger(env,{action:'update',patch:{state:'applying',before:s.safe,changes}});
 try{
  for(const old of stale){
   const fresh=await wcRead(env,s.binding.namespace,old.key,old.handle,old.kind,s.owners);
   wdAssert(arCanon(fresh.safe)===arCanon(old.safe),'Cache changed before correction');
   const after=wcReplace(fresh),expiresSoon=fresh.expiration!==null&&fresh.expiration<Math.floor(Date.now()/1000)+65;
   const change={handle:fresh.handle,kind:fresh.kind,before_sha256:fresh.safe.content_sha256,after_sha256:expiresSoon?null:await arHash(after),old_sender:WC_OLD,new_sender:WC_NEW,expiration:fresh.expiration,metadata_sha256:fresh.safe.metadata_sha256,action:expiresSoon?'expired_cache_invalidation':'sender_field_replacement',state:'attempting'};
   changes.push(change);await wcLedger(env,{action:'update',patch:{changes}});
   const url='/storage/kv/namespaces/'+s.binding.namespace+'/values/'+encodeURIComponent(fresh.key);
   if(expiresSoon)await wcApi(env,url,{method:'DELETE'});
   else{
    const form=new FormData();form.append('value',after);if(fresh.metadata!==null)form.append('metadata',JSON.stringify(fresh.metadata));
    await wcApi(env,url+(fresh.expiration===null?'':'?expiration='+fresh.expiration),{method:'PUT',body:form});
   }
   change.state='provider_accepted';await wcLedger(env,{action:'update',patch:{changes}});
  }
  await wcLedger(env,{action:'update',patch:{state:'applied',changes,finished_at:new Date().toISOString()},release:true});
  return {state:'applied',changes,credentials_and_other_fields_preserved:true,other_tenants_untouched:true,propagation_verification_pending:true,delivery_tested:false};
 }catch(e){await wcLedger(env,{action:'update',patch:{state:'failed_or_uncertain',changes,failure:wdError(e)},release:true});return {error:'Scoped sender cache correction stopped',reason:wdError(e),changes,outcome:'check sender_cache_verify before any further action'};}
}

