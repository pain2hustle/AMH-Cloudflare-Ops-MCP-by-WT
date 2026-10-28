var WALO_DIAGNOSTIC_EDITS = {"walo-mcp":[["async function notifyAustin(env, text, template) {\n  if (!env.WA_RELAY_URL || !env.WA_RELAY_KEY)\n    return { sent: false, reason: \"WhatsApp relay not configured on this Worker\",\n      how_to_connect: [\"wrangler secret put WA_RELAY_URL --profile austinsdoors   # e.g. https://api.walohq.com/send\",\n                       \"wrangler secret put WA_RELAY_KEY --profile austinsdoors   # the bridge's X-Relay-Key\"] };\n  if (!env.WA_OWNER) return { sent: false, reason: \"WA_OWNER (destination number) not set in wrangler.toml [vars]\" };\n  // The bridge refuses free-form text and accepts only approved templates \u2014 which is\n  // correct, because free-form silently fails outside the 24-hour window. `text` is\n  // logged with the call for context; the wire carries a template.\n  let status, body;\n  try {\n    const r = await fetch(env.WA_RELAY_URL, {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\", \"x-relay-key\": env.WA_RELAY_KEY },\n      body: JSON.stringify({ to: env.WA_OWNER, template: template || \"ping\" }),\n    });\n    status = r.status;\n    body = JSON.parse(scrub((await r.text()).slice(0, 2000), env.WA_RELAY_KEY) || \"{}\");\n  } catch (e) {\n    return { sent: false, reason: `relay unreachable: ${String((e && e.message) || e)}` };\n  }\n  if (status === 400 && body && body.allowed)\n    return { sent: false, reason: `template \"${template}\" is not approved`, allowed_templates: body.allowed };\n  const accepted = status >= 200 && status < 300 && body && body.ok === true;\n  return {\n    accepted, status, template: template || \"ping\", context: text || null,\n    message_id: (body && body.messageId) || null,\n    delivered: accepted ? \"unknown \u2014 a message id is not delivery\" : false,\n    caveat: \"As of 2026-09-10 the only live number is Meta's shared test line, which reaches allow-listed phones only (Austin, his dad). An approved template is the only thing that leaves the building outside the 24-hour window \u2014 the bridge enforces this by refusing free-form text.\",\n  };\n}","function safeRelayDiagnostics(body) {\n  const obj = body && typeof body === \"object\" && !Array.isArray(body) ? body : {};\n  let legacy = null;\n  if (typeof obj.detail === \"string\" && obj.detail.length <= 4096) {\n    try { legacy = JSON.parse(obj.detail); } catch {}\n  }\n  const err = legacy && typeof legacy.error === \"object\" ? legacy.error : {};\n  const number = (value, min, max) => {\n    if (!(typeof value === \"number\" || (typeof value === \"string\" && /^\\d{1,10}$/.test(value)))) return null;\n    const n = Number(value);\n    return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;\n  };\n  return {\n    upstream_status: number(obj.upstream_status ?? obj.status, 100, 599),\n    upstream_code: number(obj.upstream_code ?? err.code, 0, 2147483647),\n    upstream_subcode: number(obj.upstream_subcode ?? err.error_subcode, 0, 2147483647),\n    sender_id: typeof obj.sender_id === \"string\" && /^\\d{15,20}$/.test(obj.sender_id) ? obj.sender_id : null,\n  };\n}\n\nasync function notifyAustin(env, text, template) {\n  if (!env.WA_RELAY_URL || !env.WA_RELAY_KEY)\n    return { sent: false, reason: \"WhatsApp relay not configured on this Worker\" };\n  if (!env.WA_OWNER) return { sent: false, reason: \"WhatsApp destination not configured\" };\n  // Preserve the existing request and credentials; return only allowlisted diagnostics.\n  let status, body = null;\n  try {\n    const r = await fetch(env.WA_RELAY_URL, {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\", \"x-relay-key\": env.WA_RELAY_KEY },\n      body: JSON.stringify({ to: env.WA_OWNER, template: template || \"ping\" }),\n    });\n    status = r.status;\n    const raw = await r.text();\n    if (raw.length <= 65536) { try { body = JSON.parse(scrub(raw, env.WA_RELAY_KEY) || \"{}\"); } catch {} }\n  } catch {\n    return { sent: false, reason: \"relay unreachable\" };\n  }\n  const accepted = status >= 200 && status < 300 && body?.ok === true;\n  const messageId = body?.messageId;\n  return {\n    accepted, status,\n    template: [\"ping\", \"order_confirmed\", \"order_preparing\", \"order_ready\"].includes(template || \"ping\") ? template || \"ping\" : \"unrecognized\",\n    message_id: typeof messageId === \"string\" && /^wamid\\.[A-Za-z0-9+/=_-]{1,500}$/.test(messageId) ? messageId : null,\n    delivered: accepted ? \"unknown - a message id is not delivery\" : false,\n    ...safeRelayDiagnostics(body),\n    error_kind: accepted ? null : status === 400 && Array.isArray(body?.allowed) ? \"template_not_allowed\" : body?.error === \"graph error\" ? \"graph_error\" : \"relay_rejected\",\n    caveat: \"Meta acceptance does not confirm handset delivery. Confirm using a delivery receipt or the recipient.\",\n  };\n}"]],"localops-whatsapp-bridge":[["      console.error(\"relay /send graph fail\", res.status, text.slice(0, 200));\n      result = { ok: false, error: \"graph error\", status: res.status, detail: text.slice(0, 300) };\n      status = 502;","      let graphError = {};\n      try { graphError = JSON.parse(text)?.error || {}; } catch {}\n      const safeCode = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647 ? n : null;\n      const senderId = /^\\d{15,20}$/.test(String(pnid)) ? String(pnid) : null;\n      result = { ok: false, error: \"graph error\", status: res.status,\n        upstream_status: res.status, upstream_code: safeCode(graphError.code),\n        upstream_subcode: safeCode(graphError.error_subcode), sender_id: senderId };\n      console.error(\"relay /send graph fail\", result.upstream_status, result.upstream_code, result.upstream_subcode, result.sender_id);\n      status = 502;"],["      result = { ok: true, to: normTo, template: b.template, messageId: data?.messages?.[0]?.id || null };","      result = { ok: true, to: normTo, template: b.template, messageId: data?.messages?.[0]?.id || null, sender_id: /^\\d{15,20}$/.test(String(pnid)) ? String(pnid) : null };"]]};
var WALO_DIAGNOSTIC_PATCH_SHA = {"walo-mcp":"043e6866bf94552d0de734bfad36dc17c8128741a3fdd7cc17b7a95d55fc2e50","localops-whatsapp-bridge":"78278a930961ebb418b5a508e518f48c46122140ccdb932ecd2ed0a46bd24aa3"};
// Owner-only, one-time WALO diagnostic repair. No arbitrary code, path, credentials or sends.
var WALO_DIAGNOSTIC_ACCOUNT = '1d5fae607a857fc56cd575763bf8f3bc';
var WALO_DIAGNOSTIC_TOOL_DEF = {name:'walo_diagnostic_repair',description:'Owner-only fixed diagnostic repair for walo-mcp and localops-whatsapp-bridge in Austin Doors. Inspect returns source/config hashes and rollback version without values or source. Stage uploads only embedded reviewed edits; deploy requires staged verification. Status and guarded rollback are limited to this one-time repair. Does not send messages, change credentials, routes or policies.',inputSchema:{type:'object',additionalProperties:false,required:['script','action','_approved'],properties:{script:{type:'string',enum:['walo-mcp','localops-whatsapp-bridge']},action:{type:'string',enum:['inspect','stage','verify','deploy','status','rollback']},expected_snapshot_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},candidate_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},confirm:{type:'boolean'},_approved:{type:'boolean'}}}};
function wdAssert(ok,reason){if(!ok){const e=new Error(reason);e.wd=reason;throw e;}}
function wdError(e){return e.safe||e.wd||'Unexpected failure; operation outcome may be uncertain';}
function wdArgs(a){
 wdAssert(a&&typeof a==='object'&&!Array.isArray(a),'Invalid arguments');
 wdAssert(Object.keys(a).every(k=>['script','action','expected_snapshot_sha256','candidate_sha256','confirm','_approved'].includes(k)),'Unsupported argument');
 wdAssert(Object.hasOwn(WALO_DIAGNOSTIC_EDITS,a.script),'Worker not allowed');
 wdAssert(['inspect','stage','verify','deploy','status','rollback'].includes(a.action),'Invalid action');
 wdAssert(a._approved===true,'Explicit scoped approval required');
 for(const k of ['expected_snapshot_sha256','candidate_sha256'])if(a[k]!==undefined)wdAssert(typeof a[k]==='string'&&/^[a-f0-9]{64}$/.test(a[k]),'Invalid digest');
 if(a.confirm!==undefined)wdAssert(typeof a.confirm==='boolean','Invalid confirmation');
 if(['stage','deploy','rollback'].includes(a.action))wdAssert(a.confirm===true,'Explicit mutation confirmation required');
 return a.action;
}
function wdPatch(script,code){
 wdAssert(!code.includes('function safeRelayDiagnostics(')&&!code.includes('upstream_subcode: safeCode(graphError.error_subcode)'),'Diagnostics already present; inspect current release');
 const edits=WALO_DIAGNOSTIC_EDITS[script];
 if(script==='walo-mcp'&&code.split(edits[0][0]).length===1){const fn=wdNotifyFunction(code);wdAssert(arCanon(wdTokens(fn))===arCanon(wdTokens(edits[0][0])),'Notification logic differs from reviewed patch');return code.replace(fn,()=>edits[0][1]);}
 for(const [find,replacement]of edits){wdAssert(code.split(find).length===2,'Reviewed diagnostic patch anchor mismatch');code=code.replace(find,()=>replacement);}
 return code;
}
function wdSettings(s){const r=arSettings(s);if(Array.isArray(r.bindings))r.bindings.sort((a,b)=>a.name.localeCompare(b.name));return r;}
function wdResources(v){const r=arResources(v);if(Array.isArray(r.bindings))r.bindings.sort((a,b)=>a.name.localeCompare(b.name));return r;}
function wdBase(script){wdAssert(Object.hasOwn(WALO_DIAGNOSTIC_EDITS,script),'Worker not allowed');return 'https://api.cloudflare.com/client/v4/accounts/'+WALO_DIAGNOSTIC_ACCOUNT+'/workers/scripts/'+script;}
async function wdApi(env,script,path,init={}){
 const r=await fetch(wdBase(script)+path,{...init,headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN_DOORS,...init.headers}});
 const j=await r.json().catch(()=>null);
 if(!r.ok||!j?.success){const e=new Error('WALO provider operation failed');e.safe={status:r.status,codes:j?.errors?.map(x=>x.code).filter(Number.isSafeInteger)||[]};throw e;}
 return j.result;
}
async function wdCurrent(env,script){const d=(await wdApi(env,script,'/deployments'))?.deployments?.[0];wdAssert(d?.versions?.length===1&&d.versions[0].percentage===100,'Single active version required');return {id:d.id,versions:d.versions};}
async function wdVersion(env,script,id){wdAssert(typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id),'Invalid version');return wdApi(env,script,'/versions/'+id);}
async function wdCode(env,script,v){
 const r=await fetch(wdBase(script)+'/content/v2',{headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN_DOORS}});
 wdAssert(r.ok&&r.headers.get('etag')?.replaceAll('"','')===v.resources?.script?.etag,'Latest uploaded source differs from selected version');
 wdAssert((r.headers.get('content-type')||'').startsWith('multipart/form-data'),'Unexpected source format');
 const main=r.headers.get('cf-entrypoint'),modules=[];
 for(const [name,blob]of await r.formData()){wdAssert(blob instanceof Blob,'Unexpected source field');modules.push({name,content_type:blob.type,blob});}
 wdAssert(main&&modules.length>0&&modules.length<=100&&modules.some(m=>m.name===main)&&new Set(modules.map(m=>m.name)).size===modules.length,'Unexpected module layout');
 return {main_module:main,modules};
}
async function wdSnapshot(env,script,preview=false){
 const active=await wdCurrent(env,script),id=active.versions[0].version_id,v=await wdVersion(env,script,id),settings=await wdApi(env,script,'/settings'),body=await wdCode(env,script,v);
 wdAssert(!settings.migrations,'Migration changes not permitted');
 const main=body.modules.find(m=>m.name===body.main_module),bytes=await main.blob.arrayBuffer(),code=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 wdAssert(await arHash(code)===await arHash(bytes),'Source encoding mismatch');
 let candidate=null,comparison=null;try{candidate=await wdPatchCurrent(script,code);}catch(e){if(!preview||script!=='walo-mcp')throw e;comparison=await wdNotifyComparison(code);}
 const modules=await arModuleHashes(body);
 wdAssert(arCanon(await wdCurrent(env,script))===arCanon(active),'Concurrent deployment during inspection');
 const settingsHash=await arHash(arCanon(wdSettings(settings))),resourcesHash=await arHash(arCanon(wdResources(v)));
 const safe={account:WALO_DIAGNOSTIC_ACCOUNT,script,active,base_version:id,base_etag:v.resources.script.etag,main_module:body.main_module,module_hashes:modules,settings_sha256:settingsHash,resources_sha256:resourcesHash,candidate_sha256:candidate===null?null:await arHash(candidate),comparison,patch_sha256:WALO_DIAGNOSTIC_PATCH_SHA[script]};
 return {safe:{...safe,snapshot_sha256:await arHash(arCanon(safe)),rollback_version:id,rollback_verified:true,bindings:(settings.bindings||[]).map(b=>({name:b.name,type:b.type})),edits:WALO_DIAGNOSTIC_EDITS[script].length},settings,version:v,body,candidate};
}
function wdRid(script){return 'walo-diagnostic-20261028-v1-'+script;}
async function wdLedger(env,script,b){return wpLedger(env,{...b,rid:wdRid(script)});}
async function wdUpdate(env,script,patch,release=false){return wdLedger(env,script,{action:'update',patch,release});}
async function wdClaim(env,script,suffix,sha){
 const rid=wdRid(script)+suffix,claim=await wpLedger(env,{action:'claim',rid,jti:rid,sha,script,actor:'owner'});
 wdAssert(!claim.error,'Repair ledger refused claim');return claim;
}
async function wdVerify(env,script,rec,requireBase=true){
 wdAssert(rec?.staged_version&&rec.base_version&&rec.expected_modules,'A recorded staged repair is required');
 const base=await wdVersion(env,script,rec.base_version),next=await wdVersion(env,script,rec.staged_version);
 wdAssert(await arHash(arCanon(wdResources(base)))===rec.resources_sha256&&arCanon(wdResources(base))===arCanon(wdResources(next)),'Runtime or binding configuration differs');
 wdAssert(await arHash(arCanon(wdSettings(await wdApi(env,script,'/settings'))))===rec.settings_sha256,'Worker settings drift');
 const body=await wdCode(env,script,next);
 wdAssert(body.main_module===rec.main_module&&arCanon(await arModuleHashes(body))===arCanon(rec.expected_modules),'Uploaded modules differ');
 const active=await wdCurrent(env,script);
 wdAssert(arActive(active,requireBase?rec.base_version:rec.staged_version),'Concurrent active deployment');
 return {state:requireBase?'staged_verified':'live_verified',staged_version:rec.staged_version,base_version:rec.base_version,candidate_sha256:rec.candidate_sha256,modules_verified:true,runtime_preserved:true,settings_preserved:true,active};
}
async function wdRollback(env,script,rec){
 wdAssert(rec?.base_version&&rec.staged_version,'No rollback target recorded');
 const active=await wdCurrent(env,script);
 if(arActive(active,rec.base_version))return {state:'already_at_original',base_version:rec.base_version};
 wdAssert(arActive(active,rec.staged_version),'Concurrent deployment prevents rollback');
 const base=await wdVersion(env,script,rec.base_version);
 wdAssert(await arHash(arCanon(wdResources(base)))===rec.resources_sha256,'Rollback configuration changed');
 const claim=await wdClaim(env,script,'-rollback',rec.candidate_sha256);
 if(claim.existing)return {state:'rollback_already_attempted_check_status'};
 await wdApi(env,script,'/deployments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({strategy:'percentage',versions:[{version_id:rec.base_version,percentage:100}]})});
 wdAssert(arActive(await wdCurrent(env,script),rec.base_version),'Rollback outcome unconfirmed');
 await wpLedger(env,{action:'update',rid:wdRid(script)+'-rollback',patch:{state:'rolled_back'},release:true});
 await wdUpdate(env,script,{state:'rolled_back'},false);return {state:'rolled_back',base_version:rec.base_version};
}
async function runWaloDiagnosticRepair(args,env,authContext){
 if(authContext?.mode!=='admin'||authContext.caller==='walo'||authContext.connectionId)return {error:'WALO repair requires existing owner authorization'};
 let action;try{action=wdArgs(args);}catch(e){return {error:wdError(e)};}
 if(!env.CLOUDFLARE_API_TOKEN_DOORS||!env.RATE_LIMITER_DO)return {error:'Existing repair bindings unavailable; no fallback attempted'};
 const script=args.script;
 try{
  if(action==='inspect'){const s=await wdSnapshot(env,script,true);return {...s.safe,production_changed:false};}
  const record=(await wdLedger(env,script,{action:'get'})).record;
  if(action==='status')return {script,record:record||null,active:await wdCurrent(env,script)};
  if(action==='rollback')return await wdRollback(env,script,record);
  if(action==='stage'){
   if(record)return {already_handled:true,record};
   wdAssert(args.expected_snapshot_sha256&&args.candidate_sha256,'Inspection and tested candidate digests required');
   const s=await wdSnapshot(env,script);
   wdAssert(s.safe.snapshot_sha256===args.expected_snapshot_sha256&&s.safe.candidate_sha256===args.candidate_sha256,'Inspection or candidate drift');
   const claim=await wdClaim(env,script,'',s.safe.candidate_sha256);
   if(claim.existing)return {already_handled:true,record:claim.existing};
   const expected=[];const form=new FormData();
   const metadata={...s.settings,main_module:s.body.main_module,exports:s.version.resources.script_runtime.exports,keep_assets:true,keep_bindings:['secret_text'],bindings:s.settings.bindings.filter(b=>b.type!=='secret_text'),annotations:{'workers/message':'Approved WALO sanitized notification diagnostics','workers/tag':'walo-diagnostic-20261028'}};
   form.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}),'metadata.json');
   for(const m of s.body.modules){const blob=m.name===s.body.main_module?new Blob([s.candidate],{type:m.content_type}):m.blob;expected.push({name:m.name,type:m.content_type,bytes:blob.size,sha256:await arHash(await blob.arrayBuffer())});form.append(m.name,blob,m.name);}
   expected.sort((a,b)=>a.name.localeCompare(b.name));
   const rec={...s.safe,state:'uploading',expected_modules:expected};await wdUpdate(env,script,rec);
   try{
    wdAssert(arCanon(await wdCurrent(env,script))===arCanon(s.safe.active),'Concurrent deployment before upload');
    wdAssert(await arHash(arCanon(wdSettings(await wdApi(env,script,'/settings'))))===s.safe.settings_sha256,'Worker settings drift before upload');
    const next=await wdApi(env,script,'/versions?bindings_inherit=strict',{method:'POST',headers:{'if-match':'"'+s.safe.base_etag+'"'},body:form});
    wdAssert(typeof next.id==='string','Upload outcome has no version');
    await wdUpdate(env,script,{state:'uploaded_verifying',staged_version:next.id});
    const verified=await wdVerify(env,script,{...rec,staged_version:next.id});
    await wdUpdate(env,script,{state:'staged_verified'},true);return {...verified,production_changed:false};
   }catch(e){await wdUpdate(env,script,{state:'staging_failed_or_uncertain',failure:wdError(e)},true);throw e;}
  }
  if(action==='verify'){
   const result=await wdVerify(env,script,record);
   wdAssert(['uploaded_verifying','staging_failed_or_uncertain','staged_verified'].includes(record.state),'Operation is not awaiting stage verification');
   await wdUpdate(env,script,{state:'staged_verified',failure:null},true);return result;
  }
  wdAssert(record?.state==='staged_verified'&&args.candidate_sha256===record.candidate_sha256,'Verified staged repair and matching digest required');
  await wdVerify(env,script,record);
  const claim=await wdClaim(env,script,'-deploy',record.candidate_sha256);
  if(claim.existing)return {state:'deployment_already_attempted_check_status'};
  await wdUpdate(env,script,{state:'deploying'});
  try{
   wdAssert(arActive(await wdCurrent(env,script),record.base_version),'Concurrent deployment before activation');
   const dep=await wdApi(env,script,'/deployments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({strategy:'percentage',versions:[{version_id:record.staged_version,percentage:100}],annotations:{'workers/message':'Approved WALO diagnostics; rollback '+record.base_version}})});
   const result=await wdVerify(env,script,record,false);
   await wpLedger(env,{action:'update',rid:wdRid(script)+'-deploy',patch:{state:'live_verified'},release:true});
   await wdUpdate(env,script,{state:'live_verified',deployment_id:dep.id,finished_at:new Date().toISOString()});
   return {...result,deployment_id:dep.id,rollback_version:record.base_version,delivery_tested:false};
  }catch(e){
   await wpLedger(env,{action:'update',rid:wdRid(script)+'-deploy',patch:{state:'failed_or_uncertain'},release:true});
   let rollback;try{rollback=await wdRollback(env,script,record);}catch(re){rollback={state:'unconfirmed_or_concurrent_drift',reason:wdError(re)};}
   await wdUpdate(env,script,{state:'deployment_failed_or_uncertain',failure:wdError(e),rollback});
   return {error:'WALO diagnostic activation failed',reason:wdError(e),rollback};
  }
 }catch(e){return {error:'WALO repair stopped',reason:wdError(e)};}
}

function wdNotifyFunction(code){
 const start=code.indexOf('async function notifyAustin('),end=code.indexOf('\n}\n',start);
 wdAssert(start>=0&&end>start&&end-start<16000&&code.indexOf('async function notifyAustin(',start+1)<0,'Notification function boundary mismatch');
 return code.slice(start,end+2);
}
function wdTokens(code){
 const tokens=[];let i=0;
 while(i<code.length){
  const c=code[i];if(/\s/.test(c)){i++;continue;}
  if(code.slice(i,i+2)==='//'){const end=code.indexOf('\n',i+2);i=end<0?code.length:end+1;continue;}
  if(code.slice(i,i+2)==='/*'){const end=code.indexOf('*/',i+2);wdAssert(end>=0,'Unclosed comment');i=end+2;continue;}
  if(c==='"'||c==="'"||c==='\x60'){let j=i+1;for(;j<code.length;j++){if(code[j]==='\\'){j++;continue;}if(code[j]===c)break;}wdAssert(j<code.length,'Unclosed source literal');tokens.push(code.slice(i,j+1));i=j+1;continue;}
  const match=/^(?:[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\*\*|\+=|-=|\*=|\/=|\.\.\.)/.exec(code.slice(i));
  tokens.push(match?match[0]:c);i+=match?match[0].length:1;
 }
 return tokens;
}
async function wdNotifyComparison(code){
 const fn=wdNotifyFunction(code),actual=wdTokens(fn),expected=wdTokens(WALO_DIAGNOSTIC_EDITS['walo-mcp'][0][0]),redact=async ts=>{
  const out=[];for(const t of ts)out.push(/^["'\x60]/.test(t)||/^\d{7,}$/.test(t)?{literal_sha256:await arHash(t),bytes:new TextEncoder().encode(t).length}:t);return out;
 };
 let at=0;while(at<actual.length&&at<expected.length&&actual[at]===expected[at])at++;
 return {function_sha256:await arHash(fn),same_tokens:arCanon(actual)===arCanon(expected),actual_token_count:actual.length,expected_token_count:expected.length,first_difference:at,actual_tokens:await redact(actual),expected_tokens:await redact(expected)};
}

async function wdPatchCurrent(script,code){
 if(script==='walo-mcp'&&code.split(WALO_DIAGNOSTIC_EDITS['walo-mcp'][0][0]).length!==2){
  const fn=wdNotifyFunction(code);
  // Live source inspected through hashed-literal token comparison on 2026-10-28.
  // Exact bundled function: unchanged relay URL/key/owner/template; compiler formatting,
  // 2000 -> 2e3, redundant parentheses and escaped warning literals differ from source.
  if(await arHash(fn)==='c593570f5e00d08fd43b965c4723e2c6c2b169c73278fa2d665466e5c1f147bf')
   return code.replace(fn,()=>WALO_DIAGNOSTIC_EDITS['walo-mcp'][0][1]);
 }
 return wdPatch(script,code);
}

