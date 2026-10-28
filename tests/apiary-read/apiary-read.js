// Proposal only: fixed-resource, GET-only Apiary diagnostics. No deployment/writes.
var APIARY_READ_ACCOUNT = '1d5fae607a857fc56cd575763bf8f3bc';
var APIARY_READ_SCRIPT = 'apiary-bee';
var APIARY_READ_BUCKET = 'apiary-reading-html';
var APIARY_READ_PREFIX = 'community/reading/';
var APIARY_READ_TOOL_DEFS = [
  { name: 'apiary_worker_deployments', description: 'Read active deployment and recent deployment history for apiary-bee on Austin Doors. First item serves traffic. Past versions are rollback candidates, not validated rollbacks.', inputSchema: { type: 'object', additionalProperties: false, properties: { _approved: {type:'boolean'} } } },
  { name: 'apiary_worker_version', description: 'Read only version identity, script etag, runtime compatibility and binding names/types for one apiary-bee version. Never returns values, source code or secrets.', inputSchema: { type: 'object', additionalProperties: false, properties: { version_id: {type:'string',pattern:'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'}, _approved:{type:'boolean'} }, required:['version_id'] } },
  { name: 'apiary_r2_objects_list', description: 'One metadata-only page from apiary-reading-html, fixed community/reading/ prefix. Follow every next_cursor until page_exhausted; this call never proves the entire inventory complete.', inputSchema: { type:'object', additionalProperties:false, properties: {cursor:{type:'string',maxLength:8192},per_page:{type:'integer',minimum:1,maximum:1000,default:1000},_approved:{type:'boolean'}} } }
];
var APIARY_READ_TOOLS = new Set(APIARY_READ_TOOL_DEFS.map(t=>t.name));
function apiaryReadArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid arguments');
  const allowed = name === 'apiary_worker_version' ? ['version_id','_approved'] : name === 'apiary_r2_objects_list' ? ['cursor','per_page','_approved'] : ['_approved'];
  if(Object.keys(args).some(k=>!allowed.includes(k))) throw new Error('unsupported argument');
  if(args._approved !== undefined && typeof args._approved !== 'boolean') throw new Error('invalid approval flag');
  if(name === 'apiary_worker_version' && (typeof args.version_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(args.version_id))) throw new Error('invalid version id');
  if(name === 'apiary_r2_objects_list') {
    if(args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 8192 || /[\u0000-\u001f\u007f]/.test(args.cursor))) throw new Error('invalid cursor');
    if(args.per_page !== undefined && (!Number.isInteger(args.per_page) || args.per_page < 1 || args.per_page > 1000)) throw new Error('invalid per_page');
  }
}
function apiaryReadText(value) { return typeof value === 'string' ? value : null; }
async function runApiaryReadTool(name, args, env, authContext) {
  if(!APIARY_READ_TOOLS.has(name)) return {error:'unknown Apiary read tool'};
  if(authContext?.mode !== 'admin') return {error:'Apiary diagnostics require the existing owner/agent authorization'};
  try { apiaryReadArgs(name, args); } catch { return {error:'Invalid arguments for the fixed Apiary read scope'}; }
  // Deliberately no default-account, Pages-only or federated-execute fallback.
  if(!env.CLOUDFLARE_API_TOKEN_DOORS) return {error:'Existing Doors credential is unavailable; no fallback attempted'};
  const client = new CloudflareClient({token:env.CLOUDFLARE_API_TOKEN_DOORS});
  const root = `/accounts/${APIARY_READ_ACCOUNT}`;
  const identity = {account:APIARY_READ_ACCOUNT,script:APIARY_READ_SCRIPT};
  try {
    if(name === 'apiary_worker_deployments') {
      const {result} = await client.request('GET', `${root}/workers/scripts/${APIARY_READ_SCRIPT}/deployments`);
      if(!Array.isArray(result?.deployments)) return {error:'Unexpected deployments response; active deployment unverified'};
      const deployments = result.deployments.slice(0,50).map(d=>({id:apiaryReadText(d.id),created_on:apiaryReadText(d.created_on),source:apiaryReadText(d.source),strategy:apiaryReadText(d.strategy),versions:Array.isArray(d.versions)?d.versions.map(v=>({version_id:apiaryReadText(v.version_id),percentage:typeof v.percentage==='number'?v.percentage:null})):null}));
      return {...identity,active_deployment:deployments[0]||null,deployments,history_truncated:result.deployments.length>50,rollback_validated:false};
    }
    if(name === 'apiary_worker_version') {
      const {result:v} = await client.request('GET', `${root}/workers/scripts/${APIARY_READ_SCRIPT}/versions/${args.version_id}`);
      if(v?.id !== args.version_id) return {error:'Version identity mismatch; metadata unverified'};
      const b=v.resources?.bindings, rt=v.resources?.script_runtime;
      return {...identity,version_id:v.id,number:typeof v.number==='number'?v.number:null,created_on:apiaryReadText(v.metadata?.created_on),script_etag:apiaryReadText(v.resources?.script?.etag),compatibility_date:apiaryReadText(rt?.compatibility_date),compatibility_flags:Array.isArray(rt?.compatibility_flags)?rt.compatibility_flags.filter(x=>typeof x==='string'):null,bindings:Array.isArray(b)?b.map(x=>({name:apiaryReadText(x.name),type:apiaryReadText(x.type),...(x.type==='r2_bucket'?{bucket_name:apiaryReadText(x.bucket_name)}:{})})):null,rollback_validated:false};
    }
    const q=new URLSearchParams({prefix:APIARY_READ_PREFIX,per_page:String(args.per_page??1000)});
    if(args.cursor) q.set('cursor',args.cursor);
    const {result, result_info:rawInfo} = await client.request('GET', `${root}/r2/buckets/${APIARY_READ_BUCKET}/objects?${q}`);
    let info = rawInfo;
    // The REST API omits optional result_info on its terminal short page.
    // Confirm the boundary with a fixed-prefix start_after probe before ending.
    if (!info && Array.isArray(result) && result.length < (args.per_page ?? 1000)) {
      if(result.some(x=>typeof x.key!=='string' || !x.key.startsWith(APIARY_READ_PREFIX) || !Number.isSafeInteger(x.size) || x.size<0)) return {error:'Unexpected terminal object metadata; inventory unverified'};
      if(result.length) {
        const last = result.map(x=>x.key).sort().at(-1);
        const terminalQuery = new URLSearchParams({prefix:APIARY_READ_PREFIX,per_page:'1',start_after:last});
        const terminal = await client.request('GET', `${root}/r2/buckets/${APIARY_READ_BUCKET}/objects?${terminalQuery}`);
        if(!Array.isArray(terminal.result) || terminal.result.length || (terminal.result_info && (terminal.result_info.is_truncated !== false || terminal.result_info.delimited?.length))) return {error:'Terminal boundary probe did not confirm exhaustion; inventory incomplete'};
      }
      info = {is_truncated:false};
    }
    if(!Array.isArray(result) || typeof info?.is_truncated !== 'boolean' || (info.delimited?.length)) return {error:'Incomplete or grouped pagination metadata; inventory completeness unverified',shape:{result_is_array:Array.isArray(result),object_count:Array.isArray(result)?result.length:null,info_present:!!info,truncated_type:typeof info?.is_truncated,truncated:typeof info?.is_truncated==='boolean'?info.is_truncated:null,cursor_present:typeof info?.cursor==='string'&&!!info.cursor,delimited_type:typeof info?.delimited,delimited_count:Array.isArray(info?.delimited)?info.delimited.length:null}};
    if(info.is_truncated && (typeof info.cursor !== 'string' || !info.cursor || info.cursor===args.cursor)) return {error:'Missing or repeated continuation cursor; inventory incomplete'};
    if(result.some(x=>typeof x.key!=='string' || !x.key.startsWith(APIARY_READ_PREFIX) || !Number.isSafeInteger(x.size) || x.size<0)) return {error:'Unexpected object metadata; inventory unverified'};
    return {account:APIARY_READ_ACCOUNT,bucket:APIARY_READ_BUCKET,prefix:APIARY_READ_PREFIX,objects:result.map(x=>({key:x.key,size:x.size,etag:apiaryReadText(x.etag),last_modified:apiaryReadText(x.last_modified),content_type:apiaryReadText(x.http_metadata?.contentType)})),next_cursor:info.is_truncated?info.cursor:null,page_exhausted:!info.is_truncated,inventory_complete:false};
  } catch(e) {
    // Never echo provider error text, credentials, raw headers, or arbitrary metadata.
    return {error:'Apiary metadata read failed',status:Number.isInteger(e?.status)?e.status:null,code:Number.isInteger(e?.code)?e.code:null};
  }
}
