// One-time, owner-only repair of the already-approved Apiary cache defect.
var APIARY_REPAIR_BASE = '0a4b44d7-f34b-4ca1-9637-248373c80de3';
var APIARY_REPAIR_ETAG = '1c78e284070450cd7bd56bf8700b06f9451e62c60b339fcd568e912ffde92a9d';
var APIARY_REPAIR_RID = 'apiary-head-cache-20261028-v1';
var APIARY_REPAIR_TOOL_DEF = {name:'apiary_cache_repair',description:'Owner-only, one-time fixed Apiary HEAD/empty-cache repair. snapshot returns a private gzip backup; stage uploads the embedded reviewed patch without deploying; deploy requires verified local-preview source hash; status/rollback are limited to this operation. No arbitrary code, account, resource, cache deletion or credential changes.',inputSchema:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['inspect','snapshot','stage','restage','verify','deploy','status','rollback'],default:'snapshot'},expected_snapshot_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},backup_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},local_preview_source_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},confirm:{type:'boolean'},_approved:{type:'boolean'}}}};
function arCanon(v){return JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);}
async function arHash(v){const b=typeof v==='string'?new TextEncoder().encode(v):v;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function arB64(b){let s='';for(let n=0;n<b.length;n+=16384)s+=String.fromCharCode(...b.subarray(n,n+16384));return btoa(s);}
function arBytes(s){const decoded=atob(s),bytes=new Uint8Array(decoded.length);for(let i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);return bytes;}
function arAssert(ok,reason){if(!ok)throw new Error(reason);}
function arActive(d,id){return d?.versions?.length===1&&d.versions[0].version_id===id&&d.versions[0].percentage===100;}
function arSettings(s){const r=structuredClone(s);delete r.annotations;return r;}
function arResources(v){const r=structuredClone(v.resources);delete r.script.etag;delete r.script.last_deployed_from;return r;}
function arArgs(args){
 arAssert(args&&typeof args==='object'&&!Array.isArray(args),'Invalid arguments');
 const allowed=['action','expected_snapshot_sha256','backup_sha256','local_preview_source_sha256','confirm','_approved'];arAssert(Object.keys(args).every(k=>allowed.includes(k)),'Unsupported argument');
 const action=args.action||'snapshot';arAssert(['inspect','snapshot','stage','restage','verify','deploy','status','rollback'].includes(action),'Invalid action');
 for(const k of ['expected_snapshot_sha256','backup_sha256','local_preview_source_sha256'])if(args[k]!==undefined)arAssert(typeof args[k]==='string'&&/^[a-f0-9]{64}$/.test(args[k]),'Invalid digest');
 for(const k of ['confirm','_approved'])if(args[k]!==undefined)arAssert(typeof args[k]==='boolean','Invalid confirmation');
 if(['stage','restage','verify','deploy','rollback'].includes(action))arAssert(args.confirm===true,'Explicit repair confirmation required');
 return action;
}
function arPatch(code){
 arAssert(code.includes('PAGE_CACHE_REVISION = "20261011-reviewed-guides-final"'),'Cache revision mismatch');
 const start=code.indexOf('var apiaryWorker = {'),end=code.indexOf('\nvar apiary_entry_default = withPageCounts(',start);
 arAssert(start>=0&&end>start&&code.indexOf('var apiaryWorker = {',start+1)<0,'Apiary module boundary mismatch');
 let block=code.slice(start,end);
 const edits=[
 ['    if (hit) {','    if (hit && (await hit.clone().arrayBuffer()).byteLength > 0) {'],
 ['        if (obj) {','        if (obj && obj.size > 0) {'],
 ['    const resp = await worker_default.fetch(request, env, ctx);','    const renderRequest = request.method === "HEAD" ? new Request(request, { method: "GET" }) : request;\n    const resp = await worker_default.fetch(renderRequest, env, ctx);'],
 ['      ctx.waitUntil(cache.put(key, new Response(buf2, { status: 404, headers: h2 })));','      if (buf2.byteLength > 0) ctx.waitUntil(cache.put(key, new Response(buf2, { status: 404, headers: h2 })));'],
 ['    ctx.waitUntil(cache.put(key, stored.clone()));','    if (buf.byteLength > 0) ctx.waitUntil(cache.put(key, stored.clone()));'],
 ['    if (r2Key && env.READING_HTML) {\n      ctx.waitUntil(env.READING_HTML.put','    if (buf.byteLength > 0 && r2Key && env.READING_HTML) {\n      ctx.waitUntil(env.READING_HTML.put'],
 ['return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h2 });','return new Response(request.method === "HEAD" ? null : resp.body, { status: resp.status, statusText: resp.statusText, headers: h2 });']
 ];
 for(const [find,replacement]of edits){arAssert(block.split(find).length===2,'Reviewed cache patch anchor mismatch');block=block.replace(find,()=>replacement);}
 return {code:code.slice(0,start)+block+code.slice(end),edits:edits.length};
}
async function arApi(env,path,init={}){
 const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+APIARY_READ_ACCOUNT+'/workers/'+path,{...init,headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN_DOORS,...init.headers}});
 const j=await r.json().catch(()=>null);if(!r.ok||!j?.success){const e=new Error('Apiary provider operation failed');e.safe={status:r.status,codes:j?.errors?.map(x=>x.code).filter(x=>typeof x==='number')||[]};throw e;}return j.result;
}
async function arCurrent(env){const r=await arApi(env,'scripts/apiary-bee/deployments');arAssert(r?.deployments?.[0],'Active deployment unavailable');return r.deployments[0];}
async function arVersion(env,id){arAssert(/^[a-f0-9-]{36}$/.test(id),'Invalid stored version');return arApi(env,'scripts/apiary-bee/versions/'+id);}
async function arMetadata(env){
 const active=await arCurrent(env);arAssert(arActive(active,APIARY_REPAIR_BASE),'Active version changed from approved base');const version=await arVersion(env,APIARY_REPAIR_BASE);arAssert(version.resources?.script?.etag===APIARY_REPAIR_ETAG,'Approved base ETag mismatch');
 const settings=await arApi(env,'scripts/apiary-bee/settings'),beta=await arApi(env,'workers/apiary-bee/versions/'+APIARY_REPAIR_BASE);delete beta.modules;
 return {account:APIARY_READ_ACCOUNT,script:'apiary-bee',active_version:APIARY_REPAIR_BASE,etag:APIARY_REPAIR_ETAG,settings,version,beta};
}
async function arContent(env,etag){const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+APIARY_READ_ACCOUNT+'/workers/scripts/apiary-bee/content/v2',{headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN_DOORS}});arAssert(r.ok&&r.headers.get('etag')?.replaceAll('"','')===etag,'Latest uploaded source differs from required version');arAssert((r.headers.get('content-type')||'').startsWith('multipart/form-data'),'Unexpected source format');return r;}
async function arCode(env,id){const version=await arVersion(env,id);const r=await arContent(env,version.resources.script.etag),main=r.headers.get('cf-entrypoint');const form=await r.formData();const modules=[];for(const [name,blob]of form){arAssert(blob instanceof Blob,'Unexpected multipart text field');modules.push({name,content_type:blob.type,blob});}arAssert(main&&modules.length>0&&modules.length<=100&&modules.some(m=>m.name===main)&&new Set(modules.map(m=>m.name)).size===modules.length,'Unexpected Worker module layout');return{id,main_module:main,modules};}
async function arModuleHashes(beta){const out=[];for(const m of beta.modules)out.push({name:m.name,type:m.content_type,bytes:m.blob.size,sha256:await arHash(await m.blob.arrayBuffer())});return out.sort((a,b)=>a.name.localeCompare(b.name));}
async function arSnapshot(env){
 const snapshot=await arMetadata(env),body=await arCode(env,APIARY_REPAIR_BASE);arAssert(body.main_module===snapshot.beta.main_module,'Main module mismatch');const patch=arPatch(await body.modules.find(m=>m.name===body.main_module).blob.text()),modules=await arModuleHashes(body);arAssert(arActive(await arCurrent(env),APIARY_REPAIR_BASE),'Concurrent deployment during snapshot');
 return {snapshot,patch,modules,modulesBody:body.modules,snapshot_sha256:await arHash(arCanon(snapshot)),settings_sha256:await arHash(arCanon(arSettings(snapshot.settings))),candidate_sha256:await arHash(patch.code)};
}
async function arLedger(env,b){return wpLedger(env,{...b,rid:APIARY_REPAIR_RID});}
async function arUpdate(env,patch,release=false){return arLedger(env,{action:'update',patch,release});}
async function arChecks(){const result=[];for(const slug of ['biggie-medieval-manuscript-letters','wiki-zweistein','wiki-raether-limit']){const url='https://apiarybee.com/community/reading/'+slug;const h=await fetch(url,{method:'HEAD',redirect:'manual'});const headBytes=(await h.arrayBuffer()).byteLength;const r=await fetch(url,{redirect:'manual'});const html=await r.text();result.push({slug,head_status:h.status,head_bytes:headBytes,get_status:r.status,bytes:new TextEncoder().encode(html).length,ok:h.status===200&&headBytes===0&&r.status===200&&html.includes('<html')&&html.includes(url)});}return {ok:result.every(x=>x.ok),checks:result};}
async function arRollback(env,record){const active=await arCurrent(env);if(arActive(active,APIARY_REPAIR_BASE))return {state:'already_at_original',active_version:APIARY_REPAIR_BASE};arAssert(arActive(active,record.staged_version),'Concurrent deployment prevents rollback');await arVersion(env,APIARY_REPAIR_BASE);await arApi(env,'scripts/apiary-bee/deployments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({strategy:'percentage',versions:[{version_id:APIARY_REPAIR_BASE,percentage:100}],annotations:{'workers/message':'Rollback approved Apiary cache repair'}})});arAssert(arActive(await arCurrent(env),APIARY_REPAIR_BASE),'Rollback outcome unconfirmed');await arUpdate(env,{state:'rolled_back',finished_at:new Date().toISOString()},true);return {state:'rolled_back',active_version:APIARY_REPAIR_BASE};}
var APIARY_REPAIR_PRESERVED_MODULES = [{name:'apiary-entry.js.map',type:'application/source-map',bytes:21209889,sha256:'730bcb29a05d854d50c4d422cf05c6cfb20e8dbcd7d1d4ae642a01cfd785e9ad'}];
async function arVerifyFixedBody(body,record){const hashes=await arModuleHashes(body);arAssert(body.main_module==='apiary-entry.js'&&hashes.find(m=>m.name===body.main_module)?.sha256===record.candidate_sha256,'Reviewed candidate body mismatch');arAssert(arCanon(hashes.filter(m=>m.name!==body.main_module))===arCanon(APIARY_REPAIR_PRESERVED_MODULES),'Preserved modules differ from verified backup');return hashes;}
async function arRestage(env,args,record){
 arAssert(record?.state==='staging_failed'&&record.failure==='Uploaded runtime configuration differs'&&record.staged_version,'No eligible failed stage');arAssert(args.local_preview_source_sha256===record.candidate_sha256&&args.backup_sha256===record.backup_sha256,'Verified backup and preview digests required');arAssert(arActive(await arCurrent(env),APIARY_REPAIR_BASE),'Concurrent deployment');
 const original=await arVersion(env,APIARY_REPAIR_BASE),failed=await arVersion(env,record.staged_version),a=arResources(original),b=arResources(failed);arAssert(a.script_runtime.exports&&!b.script_runtime.exports,'Failure is not an omitted export declaration');delete a.script_runtime.exports;arAssert(arCanon(a)===arCanon(b),'Other runtime differences prevent retry');
 const settings=await arApi(env,'scripts/apiary-bee/settings');arAssert(await arHash(arCanon(arSettings(settings)))===record.settings_sha256,'Worker settings drift');let body=await arCode(env,record.staged_version);const expected=await arVerifyFixedBody(body,record);
 const rid=APIARY_REPAIR_RID+'-exports-retry',claim=await wpLedger(env,{action:'claim',rid,jti:rid,sha:record.candidate_sha256,script:'apiary-bee',actor:'owner'});arAssert(!claim.error,'Retry lock unavailable');if(claim.existing)return {already_handled:true,record};
 await arUpdate(env,{state:'restaging',previous_staged_version:record.staged_version});
 try{
  const metadata={...settings,main_module:body.main_module,exports:original.resources.script_runtime.exports,keep_assets:true,keep_bindings:['secret_text'],bindings:settings.bindings.filter(x=>x.type!=='secret_text'),annotations:{'workers/message':'Approved Apiary cache repair; preserve existing exports','workers/tag':'apiary-cache-repair-20261028'}};
  let form=new FormData();form.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}),'metadata.json');for(const m of body.modules)form.append(m.name,m.blob,m.name);arAssert(arActive(await arCurrent(env),APIARY_REPAIR_BASE),'Concurrent deployment before restage');
  const next=await arApi(env,'scripts/apiary-bee/versions?bindings_inherit=strict',{method:'POST',headers:{'if-match':'"'+failed.resources.script.etag+'"'},body:form});form=null;body=null;arAssert(typeof next.id==='string','Restage outcome has no version');await arUpdate(env,{state:'uploaded_verifying',staged_version:next.id});
  const v=await arVersion(env,next.id);arAssert(arCanon(arResources(original))===arCanon(arResources(v)),'Restaged runtime configuration differs');arAssert(await arHash(arCanon(arSettings(await arApi(env,'scripts/apiary-bee/settings'))))===record.settings_sha256,'Settings changed during restage');const uploaded=await arCode(env,next.id);arAssert(arCanon(await arVerifyFixedBody(uploaded,record))===arCanon(expected),'Restaged code differs');arAssert(arActive(await arCurrent(env),APIARY_REPAIR_BASE),'Production changed during restage');
  await arUpdate(env,{state:'staged_verified',module_hashes:expected,staged_etag:v.resources.script.etag,local_preview_source_sha256:args.local_preview_source_sha256,failure:null});await wpLedger(env,{action:'update',rid,patch:{state:'verified'},release:true});return {state:'staged_verified',staged_version:next.id,base_version:APIARY_REPAIR_BASE,production_changed:false,modules_verified:true,runtime_preserved:true,settings_preserved:true,exports_preserved:true,candidate_sha256:record.candidate_sha256};
 }catch(e){await arUpdate(env,{state:'restaging_failed',failure:e.safe||e.message});await wpLedger(env,{action:'update',rid,patch:{state:'failed'},release:true});throw e;}
}
async function arVerifyStaged(env,args,record){
 arAssert(record?.state==='restaging_failed'&&record.failure?.status===500&&arCanon(record.failure.codes)==='[10500]'&&record.staged_version,'No eligible interrupted verification');
 arAssert(args.local_preview_source_sha256===record.candidate_sha256&&args.backup_sha256===record.backup_sha256,'Verified backup and preview digests required');arAssert(arActive(await arCurrent(env),APIARY_REPAIR_BASE),'Concurrent deployment');
 const original=await arVersion(env,APIARY_REPAIR_BASE),v=await arVersion(env,record.staged_version);arAssert(arCanon(arResources(original))===arCanon(arResources(v)),'Staged runtime differs');
 arAssert(await arHash(arCanon(arSettings(await arApi(env,'scripts/apiary-bee/settings'))))===record.settings_sha256,'Worker settings drift');
 const hashes=await arVerifyFixedBody(await arCode(env,record.staged_version),record);arAssert(arActive(await arCurrent(env),APIARY_REPAIR_BASE),'Production changed during verification');
 await arUpdate(env,{state:'staged_verified',module_hashes:hashes,staged_etag:v.resources.script.etag,local_preview_source_sha256:args.local_preview_source_sha256,failure:null});
 return {state:'staged_verified',staged_version:record.staged_version,production_changed:false,modules_verified:true,runtime_preserved:true,settings_preserved:true,exports_preserved:true,candidate_sha256:record.candidate_sha256};
}
async function runApiaryRepair(args,env,authContext){
 // Existing owner/admin keys only; exclude WALO's separate privileged integration.
 if(authContext?.mode!=='admin'||authContext.caller==='walo'||authContext.connectionId)return {error:'Apiary repair requires existing owner authorization'};
 let action;try{action=arArgs(args);}catch(e){return {error:e.message};}
 if(!env.CLOUDFLARE_API_TOKEN_DOORS||!env.RATE_LIMITER_DO)return {error:'Existing repair bindings unavailable; no fallback attempted'};
 try{
  if(action==='inspect'){
   const active=await arCurrent(env),v=await arVersion(env,APIARY_REPAIR_BASE);
   const b=await arApi(env,'workers/apiary-bee/versions/'+APIARY_REPAIR_BASE);
   const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+APIARY_READ_ACCOUNT+'/workers/scripts/apiary-bee/content/v2',{headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN_DOORS}});
   const headers={status:r.status,content_type:r.headers.get('content-type'),content_length:r.headers.get('content-length'),etag:r.headers.get('etag'),'cf-entrypoint':r.headers.get('cf-entrypoint')};await r.body?.cancel();
   return {active_version:active.versions,base_etag:v.resources.script.etag,main_module:b.main_module,beta_keys:Object.keys(b).filter(k=>k!=='bindings'),module_count:b.modules?.length,headers};
  }
  if(action==='snapshot'){
   const snapshot=await arMetadata(env),r=await arContent(env,APIARY_REPAIR_ETAG),contentType=r.headers.get('content-type'),main=r.headers.get('cf-entrypoint');arAssert(main===snapshot.beta.main_module,'Main module mismatch');
   const gzip=new Uint8Array(await new Response(r.body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer());arAssert(gzip.length<16*1024*1024,'Compressed backup exceeds bounded size');arAssert(arActive(await arCurrent(env),APIARY_REPAIR_BASE),'Concurrent deployment during backup');
   return {action,account:APIARY_READ_ACCOUNT,script:'apiary-bee',base_version:APIARY_REPAIR_BASE,base_etag:APIARY_REPAIR_ETAG,main_module:main,snapshot_sha256:await arHash(arCanon(snapshot)),private_metadata:snapshot,backup_sha256:await arHash(gzip),backup_encoding:'gzip+base64-multipart',backup_content_type:contentType,backup_bytes:gzip.length,backup_base64:arB64(gzip),edits:7,revision:'20261011-reviewed-guides-final',production_changed:false};
  }
  const record=(await arLedger(env,{action:'get'})).record;
  if(action==='status'){
   const out={record:record||null,active_deployment:await arCurrent(env)};
   if(record?.staged_version){const a=arResources(await arVersion(env,APIARY_REPAIR_BASE)),b=arResources(await arVersion(env,record.staged_version));const paths=[];const walk=(x,y,p)=>{if(arCanon(x)===arCanon(y))return;if(x&&y&&typeof x==='object'&&typeof y==='object'&&!Array.isArray(x)&&!Array.isArray(y)){for(const k of new Set([...Object.keys(x),...Object.keys(y)]))walk(x[k],y[k],p+'.'+k);}else paths.push({path:p,before_type:Array.isArray(x)?'array':typeof x,after_type:Array.isArray(y)?'array':typeof y});};walk(a,b,'resources');const sortBindings=v=>Array.isArray(v)?[...v].sort((x,y)=>x.name.localeCompare(y.name)):v;out.configuration_differences=paths;out.binding_sets_identical=arCanon(sortBindings(a.bindings))===arCanon(sortBindings(b.bindings));out.runtime_keys={before:Object.keys(a.script_runtime||{}),after:Object.keys(b.script_runtime||{})};}
   return out;
  }
  if(action==='restage')return await arRestage(env,args,record);
  if(action==='verify')return await arVerifyStaged(env,args,record);
  if(action==='rollback'){arAssert(record?.staged_version,'No repair version recorded');return await arRollback(env,record);}
  if(action==='stage'){
   if(record)return {already_handled:true,record};
   arAssert(args.expected_snapshot_sha256&&args.backup_sha256&&args.local_preview_source_sha256,'Backup and local preview digests required');
   const s=await arSnapshot(env);arAssert(s.snapshot_sha256===args.expected_snapshot_sha256,'Snapshot drift');arAssert(s.candidate_sha256===args.local_preview_source_sha256,'Previewed candidate differs');
   // Owner confirms the locally verified streamed backup digest; source identity is independently pinned by immutable ETag and snapshot hash.
   const claimed=await arLedger(env,{action:'claim',jti:APIARY_REPAIR_RID,sha:s.candidate_sha256,script:'apiary-bee',actor:'owner'});arAssert(!claimed.error,'Repair ledger refused claim');if(claimed.existing)return {already_handled:true,record:claimed.existing};
   await arUpdate(env,{state:'uploading',base_version:APIARY_REPAIR_BASE,base_etag:APIARY_REPAIR_ETAG,snapshot_sha256:s.snapshot_sha256,backup_sha256:args.backup_sha256,candidate_sha256:s.candidate_sha256,settings_sha256:s.settings_sha256,revision:'20261011-reviewed-guides-final'});
   try{
    const metadata={...s.snapshot.settings,main_module:s.snapshot.beta.main_module,exports:s.snapshot.version.resources.script_runtime.exports,keep_assets:true,keep_bindings:['secret_text'],bindings:s.snapshot.settings.bindings.filter(b=>b.type!=='secret_text'),annotations:{'workers/message':'Approved Apiary HEAD and empty-cache fix; unchanged revision','workers/tag':'apiary-cache-repair-20261028'}};
    let form=new FormData();form.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}),'metadata.json');
    const expected=[];for(const m of s.modulesBody){const blob=m.name===s.snapshot.beta.main_module?new Blob([s.patch.code],{type:m.content_type}):m.blob;expected.push({name:m.name,type:m.content_type,bytes:blob.size,sha256:await arHash(await blob.arrayBuffer())});form.append(m.name,blob,m.name);}
    arAssert(arActive(await arCurrent(env),APIARY_REPAIR_BASE),'Concurrent deployment before upload');
    const next=await arApi(env,'scripts/apiary-bee/versions?bindings_inherit=strict',{method:'POST',headers:{'if-match':'"'+APIARY_REPAIR_ETAG+'"'},body:form});arAssert(typeof next.id==='string','Upload outcome has no version');
    form=null;s.modulesBody=null;s.patch=null;await arUpdate(env,{state:'uploaded_verifying',staged_version:next.id});
    const version=await arVersion(env,next.id);arAssert(arCanon(arResources(s.snapshot.version))===arCanon(arResources(version)),'Uploaded runtime configuration differs');
    const newSettings=await arApi(env,'scripts/apiary-bee/settings');arAssert(await arHash(arCanon(arSettings(newSettings)))===s.settings_sha256,'Worker settings changed on upload');
    const beta=await arCode(env,next.id);arAssert(beta.main_module===s.snapshot.beta.main_module&&arCanon(await arModuleHashes(beta))===arCanon(expected.sort((a,b)=>a.name.localeCompare(b.name))),'Uploaded modules differ');
    arAssert(arActive(await arCurrent(env),APIARY_REPAIR_BASE),'Production changed during staging');await arUpdate(env,{state:'staged_verified',module_hashes:expected,staged_etag:version.resources.script.etag,local_preview_source_sha256:args.local_preview_source_sha256});
    return {state:'staged_verified',staged_version:next.id,base_version:APIARY_REPAIR_BASE,production_changed:false,modules_verified:true,runtime_preserved:true,settings_preserved:true,candidate_sha256:s.candidate_sha256};
   }catch(e){await arUpdate(env,{state:'staging_failed',failure:e.safe||e.message},true);throw e;}
  }
  arAssert(record?.state==='staged_verified','A verified staged repair is required');arAssert(args.local_preview_source_sha256===record.candidate_sha256,'Local preview digest required');
  const original=await arVersion(env,APIARY_REPAIR_BASE),staged=await arVersion(env,record.staged_version);arAssert(staged.resources.script.etag===record.staged_etag&&arCanon(arResources(original))===arCanon(arResources(staged)),'Staged immutable identity changed');
  arAssert(await arHash(arCanon(arSettings(await arApi(env,'scripts/apiary-bee/settings'))))===record.settings_sha256,'Worker configuration drift');
  arAssert(arActive(await arCurrent(env),APIARY_REPAIR_BASE),'Concurrent active deployment');
  await arUpdate(env,{state:'deploying'});
  try{
   const dep=await arApi(env,'scripts/apiary-bee/deployments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({strategy:'percentage',versions:[{version_id:record.staged_version,percentage:100}],annotations:{'workers/message':'Approved Apiary cache fix; rollback '+APIARY_REPAIR_BASE}})});
   arAssert(arActive(await arCurrent(env),record.staged_version),'Deployment outcome unconfirmed');await arUpdate(env,{state:'live_verifying',deployment_id:dep.id});
   const checks=await arChecks();arAssert(checks.ok,'Live verification failed');const result={state:'live_verified',version:record.staged_version,rollback_version:APIARY_REPAIR_BASE,deployment_id:dep.id,checks,revision:'20261011-reviewed-guides-final',finished_at:new Date().toISOString()};await arUpdate(env,result,true);return result;
  }catch(e){let rollback;try{rollback=await arRollback(env,record);}catch{rollback={state:'unconfirmed_or_concurrent_drift'};}await arUpdate(env,{state:'deployment_failed',failure:e.safe||e.message,rollback},true);return {error:'Apiary deployment failed',failure:e.safe||e.message,rollback};}
 }catch(e){return {error:'Apiary repair stopped',reason:e.safe||e.message};}
}