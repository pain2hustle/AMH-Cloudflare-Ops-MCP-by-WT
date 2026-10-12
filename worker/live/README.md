# Live hub bundle (what mcp.artificialmindhive.com actually runs)

`index.js` here is the exact code deployed to the `cloudflare-ops-mcp` Worker (pain2hustle1).
It is NEWER than `src/` + `worker/`: the live Worker has the per-agent keys (`MCP_EXTRA_ADMIN_KEYS`, `?key=`)
that the modular source never got. Running `wrangler deploy` from `worker/` ships the OLD code and cuts
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
