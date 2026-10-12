// Injects the token-vending mint log + hourly auditor into worker/live/index.js (idempotent guard).
// Run: node inject-token-audit.cjs   (then upload index.js per README.md)
const fs = require("fs");
const F = __dirname + "/index.js";
let s = fs.readFileSync(F, "utf8");
if (s.includes("auditMintedTokens")) { console.log("already injected"); process.exit(0); }
const rep = (a, b) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${a.slice(0, 60)}`); s = s.replace(a, () => b); };

// 1. every minted token is named "cfops …" so the auditor can tell it from Austin's own tokens
rep("    name: name || `cfops ${preset} ${zone.name} (auto-expires)`,",
    "    name: \"cfops \" + (name ? String(name).replace(/^cfops\\s*/i, \"\").slice(0, 80) : `${preset} ${zone.name} (auto-expires)`),");

// 2. mint log: what the auditor trusts
rep('    case "mint_scoped_token":\n      return await mintScopedToken(client, {',
    '    case "mint_scoped_token": {\n      const minted = await mintScopedToken(client, {');
rep('        name: args.name,\n        apply: args.apply === true\n      });\n    case "list_tokens":',
    '        name: args.name,\n        apply: args.apply === true\n      });\n' +
    '      if (minted && minted.apply === true && minted.id && env.CLOUDFLARE_OPS_OAUTH) {\n' +
    '        const zoneId = await resolveZone2(client, domain).then((z) => z && z.id).catch(() => null);\n' +
    '        await env.CLOUDFLARE_OPS_OAUTH.put(`mintlog:${minted.id}`, JSON.stringify({ id: minted.id, domain: minted.domain, zone_id: zoneId, preset: minted.preset, expires_on: minted.expires_on, at: new Date().toISOString(), actor: authContext?.connectionId || authContext?.mode || "unknown" }), { expirationTtl: 60 * 60 * 24 * 30 });\n' +
    '      }\n      return minted;\n    }\n    case "list_tokens":');

// 3. the hourly auditor. Only ever touches tokens named "cfops …".
rep("var index_default = {\n  async fetch(request, env) {",
`// Token-vending auditor (hourly cron). Revokes hub-minted ("cfops …") tokens that have no mint log,
// reach beyond the one zone they were minted for, have no expiry, or are already expired.
// Tokens not named "cfops …" (Austin's own) are never read past the name and never touched.
async function auditMintedTokens(env) {
  const report = { at: new Date().toISOString(), checked: 0, revoked: [], kept: 0, errors: [] };
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) { report.errors.push("no CLOUDFLARE_API_TOKEN"); return report; }
  const client = new CloudflareClient({ token });
  let list = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const { result } = await client.request("GET", \`/user/tokens?per_page=50&page=\${page}\`);
      list.push(...(result || []));
      if (!result || result.length < 50) break;
    }
  } catch (e) { report.errors.push("list: " + String(e.message || e).slice(0, 160)); }
  for (const t of list) {
    if (!/^cfops /.test(String(t.name || ""))) continue;
    report.checked++;
    let why = null;
    const log = env.CLOUDFLARE_OPS_OAUTH ? await env.CLOUDFLARE_OPS_OAUTH.get(\`mintlog:\${t.id}\`, "json") : null;
    if (t.status === "expired" || (t.expires_on && Date.parse(t.expires_on) < Date.now())) why = "expired";
    else if (!t.expires_on) why = "no expiry";
    else if (!log) why = "no mint log entry";
    else {
      const res = (t.policies || []).flatMap((p) => Object.keys(p.resources || {}));
      if (!log.zone_id || res.some((r) => r !== \`com.cloudflare.api.account.zone.\${log.zone_id}\`)) why = "scope beyond its zone";
    }
    if (!why) { report.kept++; continue; }
    try { await client.request("DELETE", \`/user/tokens/\${encodeURIComponent(t.id)}\`); report.revoked.push({ id: t.id, name: t.name, why }); }
    catch (e) { report.errors.push(\`revoke \${t.id}: \${String(e.message || e).slice(0, 120)}\`); }
  }
  if (env.CLOUDFLARE_OPS_OAUTH) await env.CLOUDFLARE_OPS_OAUTH.put("audit:last", JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 30 });
  console.log(JSON.stringify({ event: "token_audit", ...report }));
  return report;
}
__name(auditMintedTokens, "auditMintedTokens");
var index_default = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(auditMintedTokens(env).catch((e) => console.log(JSON.stringify({ event: "token_audit_failed", error: String(e && e.message || e).slice(0, 200) }))));
  },
  async fetch(request, env) {`);

// 4. let list_tokens show the last audit
rep('      return { tokens: await listTokens(client), presets: Object.keys(TOKEN_PRESETS) };',
    '      return { tokens: await listTokens(client), presets: Object.keys(TOKEN_PRESETS), last_audit: env.CLOUDFLARE_OPS_OAUTH ? await env.CLOUDFLARE_OPS_OAUTH.get("audit:last", "json") : null };');

s = s.replace('  version: "0.6.0"\n};', '  version: "0.6.1"\n};');
fs.writeFileSync(F, s);
console.log("injected", s.length);
