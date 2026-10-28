async function resolveTenant(inbound, env) {
  const { routeType, routeValue } = inbound || {};
  if (!routeType || routeValue == null || routeValue === "") return null;
  const cacheKey = `tenant:${routeType}:${routeValue}`;
  if (env.CHAT) {
    try {
      const c = await env.CHAT.get(cacheKey);
      if (c) return JSON.parse(c);
    } catch {
    }
  }
  if (!env.DB) return matchesFounderRoute(inbound, env) ? FOUNDER_DEFAULT_TENANT : null;
  let tenant = null;
  try {
    const row = await env.DB.prepare(
      `SELECT t.id,t.slug,t.business_name,t.status,t.plan,t.timezone,t.voice,
              t.hours_json,t.config_json,
              s.indexnow_host,s.indexnow_key,s.wa_phone_number_id,s.wa_display_number,
              s.lead_token,s.relay_key_hash
         FROM routes r
         JOIN tenants t ON t.id = r.tenant_id
         LEFT JOIN tenant_secrets s ON s.tenant_id = t.id
        WHERE r.route_type = ? AND r.route_value = ? LIMIT 1`
    ).bind(routeType, String(routeValue)).first();
    if (!row) return null;
    if (row.status && row.status !== "active") return null;
    const owners = await env.DB.prepare(
      `SELECT phone FROM tenant_owners WHERE tenant_id = ? AND role = 'owner'`
    ).bind(row.id).all();
    tenant = assembleTenant(row, owners?.results || []);
    tenant.prices = await loadPrices(env, row.id);
  } catch (e) {
    console.error("resolveTenant D1 error", e && e.message ? e.message : e);
    if (env.CHAT) {
      try {
        const b = await env.CHAT.get("tenantbak:" + routeType + ":" + routeValue);
        if (b) return JSON.parse(b).t;
      } catch {
      }
    }
    return matchesFounderRoute(inbound, env) ? FOUNDER_DEFAULT_TENANT : null;
  }
  if (tenant && env.CHAT) {
    try {
      await env.CHAT.put(cacheKey, JSON.stringify(tenant), { expirationTtl: 300 });
      const bk = "tenantbak:" + routeType + ":" + routeValue, old = await env.CHAT.get(bk);
      if (!old || Date.now() - (JSON.parse(old).at || 0) > 864e5) await env.CHAT.put(bk, JSON.stringify({ at: Date.now(), t: tenant }), { expirationTtl: 60 * 86400 });
    } catch {
    }
  }
  return tenant;
}
async function resolveTenantByRelayKey(key, env) {
  if (!key) return null;
  if (env.DB) {
    const hash = await sha256Hex(key);
    return resolveTenant({ routeType: "relay_key_hash", routeValue: hash }, env);
  }
  if (env.RELAY_KEY && timingSafeEqualStr(key, env.RELAY_KEY)) return FOUNDER_DEFAULT_TENANT;
  return null;
}
