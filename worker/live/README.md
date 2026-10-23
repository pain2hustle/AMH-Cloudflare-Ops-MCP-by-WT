> **2026-10-17 OAuth update:** index.js is now built by ../mcp-oauth/build.mjs from the recovered production baseline and the OAuth wrapper. See [MCP OAuth](../mcp-oauth/README.md). Preserve this wrapper and the global_fetch_strictly_public compatibility flag in subsequent releases.

# Live hub bundle (what mcp.artificialmindhive.com actually runs)

`index.js` here is the exact code deployed to the `cloudflare-ops-mcp` Worker (pain2hustle1).
It is NEWER than `src/` + `worker/`: the live Worker has the per-agent keys (`MCP_EXTRA_ADMIN_KEYS`, `?key=`)
that the modular source never got.

> **WALO board key (2026-10-23):** WALO no longer signs in with the main admin key or an `MCP_EXTRA_ADMIN_KEYS` entry.
> It has its own dedicated Worker secret, `WALO_BOARD_KEY`, on this hub. It matches the `AMH_BOARD_KEY` secret on WALO.
> The hub accepts it on `/board/api` and `/mcp` and tags those calls with caller identity `walo`. Values live only as
> Worker secrets on the two Workers, never in files or docs. Running `wrangler deploy` from `worker/` ships the OLD code and cuts
off Grok's key.

To change the hub: edit this bundle (or inject a module the same way `src/pages-deploy.js` was injected),
then upload it with the Workers API keeping bindings, e.g.:

    PUT /accounts/0ebf6d…/workers/scripts/cloudflare-ops-mcp
      metadata = {"main_module":"index.js","compatibility_date":"2026-08-17","compatibility_flags":["nodejs_compat"],
                  "keep_bindings":["secret_text","plain_text","kv_namespace","service","durable_object_namespace","ratelimit","assets"],
                  "keep_assets":true}
      index.js = this file (filename=index.js, type application/javascript+module)

Before any change, download the live code again (`/workers/scripts/cloudflare-ops-mcp/content/v2`) in case
someone deployed since.

## Versions
- 0.5.3: live before 2026-10-12. Rollback version id `010da4f5-4867-462e-ac14-183d5c26757b`.
- 0.6.0 (2026-10-12): `src/pages-deploy.js` added. Tools: pages_deploy, pages_list_deployments,
  pages_get_deployment, pages_rollback, wrangler_doctor.
  - Second account: secret `CLOUDFLARE_API_TOKEN_DOORS` (austinsdoors1), used for admin keys only.
  - artificialmindhive production is refused.
  - Tested end to end on a throwaway project (deploy, image, _redirects, list); the project was deleted after.
- 0.6.1 (2026-10-12): token vending, via `inject-token-audit.cjs`.
  - Every minted token is named `cfops …`, and each mint writes KV `mintlog:<id>`.
  - `auditMintedTokens` revokes `cfops …` tokens that are expired, have no expiry, have no mint log, or reach beyond their zone. Austin's own tokens are never touched.
  - It runs at most hourly, piggybacked on real traffic: the free plan's 5 cron slots on pain2hustle1 are all used.
  - The last report is in KV `audit:last` and is shown by list_tokens.
  - mint_scoped_token policy was already allow (no policies set).
  - list_tokens/mint return 9109 until the hub token gets User → API Tokens → Edit.
- 0.6.3 (2026-10-12): Cloudflare's official MCP is federated, and the token auditor is adjustable.
  - **Federation:** mcp.cloudflare.com/mcp as `cf` (amh, token cfat_PZ99…) and `cfdoors` (austinsdoors1, cfut_oKK…). It covers the full CF API through docs/search/execute/whoami.
  - **Ordering:** tools/list puts `cf__*`/`cfdoors__*` right after the native tools, because Grok keeps only about 45 tools.
  - **`token_audit_settings {unused_days}`:** the auditor's default unused limit, stored in KV `cfg:unused_days` (default 7). Only admin keys can change it.
  - **`mint_scoped_token` `keep_days`:** a per-token override, stored in the mint log.
  - **Note:** `cf__execute` is the raw API, so the hub's artificialmindhive deploy guard does not apply to it. The landing guard and rollback are the safety net there.
