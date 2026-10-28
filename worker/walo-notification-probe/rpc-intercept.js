async function handleRpc(msg, env, scope = "owner") {
  if(msg?.method==="tools/list"&&scope==="owner"&&env.MCP_KEY&&msg.id!==undefined&&msg.id!==null)
    return rpcResult(msg.id,{tools:[...TOOLS,...GB_TOOLS,WALO_NOTIFICATION_TRACE_DEF]});
  if(msg?.method==="tools/call"&&msg.params?.name==="walo_notification_trace"){
    if(msg.id===undefined||msg.id===null)return null;
    if(scope!=="owner"||!env.MCP_KEY)return rpcError(msg.id,-32601,"tool not available for this key");
    if(msg.params.arguments&&(typeof msg.params.arguments!=="object"||Array.isArray(msg.params.arguments)||Object.keys(msg.params.arguments).length))
      return rpcError(msg.id,-32602,"diagnostic takes no arguments");
    const trace=await traceNotificationConfiguration(env,scope);
    return rpcResult(msg.id,{content:[{type:"text",text:JSON.stringify(trace)}]});
  }