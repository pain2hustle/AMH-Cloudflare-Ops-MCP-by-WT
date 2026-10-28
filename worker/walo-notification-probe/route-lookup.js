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
