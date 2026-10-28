var WALO_NOTIFICATION_TRACE_DEF = {name:"walo_notification_trace",description:"Owner-only read-only notification configuration diagnostic. Returns only relay category, tenant-1 key match, sender ID and owner-destination match. No URL/key/hash/phone disclosure, HTTP requests, writes or messages.",inputSchema:{type:"object",additionalProperties:false,properties:{}}};
async function traceNotificationConfiguration(env,scope){
 if(scope!=="owner"||!env.MCP_KEY)return {error:"Existing owner authentication required"};
 const out={relay_category:"unconfigured",key_maps_tenant1:null,sender_id:null,owner_destination_matches:null};
 if(env.WA_RELAY_URL)try{
  const u=new URL(env.WA_RELAY_URL),known={"api.walohq.com":"api_walohq","whatsapp.paycovay.com":"whatsapp_paycovay","localops-whatsapp-bridge.austinsdoors.workers.dev":"bridge_workers_dev"};
  out.relay_category=u.protocol==="https:"&&!u.port&&u.pathname==="/send"&&!u.username&&!u.password&&!u.search&&!u.hash&&Object.hasOwn(known,u.hostname)?known[u.hostname]:"other";
 }catch{out.relay_category="invalid";}
 if(!env.WA_RELAY_KEY||!env.DB)return out;
 try{
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(env.WA_RELAY_KEY)));
  const keyHash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
  const row=await env.DB.prepare("SELECT CASE WHEN tenant_id='1' THEN 1 ELSE 0 END AS is_tenant1 FROM routes WHERE route_type='relay_key_hash' AND route_value=? LIMIT 1").bind(keyHash).first();
  out.key_maps_tenant1=!!row&&row.is_tenant1===1;
  if(!out.key_maps_tenant1)return out;
  const t=await env.DB.prepare("SELECT t.status,s.wa_phone_number_id FROM tenants t LEFT JOIN tenant_secrets s ON s.tenant_id=t.id WHERE t.id='1'").first();
  out.sender_id=t?.status==="active"&&typeof t.wa_phone_number_id==="string"&&/^\d{15,20}$/.test(t.wa_phone_number_id)?t.wa_phone_number_id:null;
  const owner=String(env.WA_OWNER||"").replace(/\D/g,"");
  if(owner){const o=await env.DB.prepare("SELECT COUNT(*) AS matches FROM tenant_owners WHERE tenant_id='1' AND role='owner' AND replace(phone,'+','')=?").bind(owner).first();out.owner_destination_matches=Number(o?.matches)>0;}
 }catch{out.key_maps_tenant1=null;out.sender_id=null;out.owner_destination_matches=null;}
 return out;
}
