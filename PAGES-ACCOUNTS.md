# Shared Pages account routing

| Alias | Cloudflare account | Owner secret binding |
| --- | --- | --- |
| amh | 0ebf6d65d7a9ddccd41cba0b8bd1414c | CLOUDFLARE_API_TOKEN |
| doors | 1d5fae607a857fc56cd575763bf8f3bc | CLOUDFLARE_API_TOKEN_DOORS |
| artificialmindhive | a08783a0d3715df907ed5ccad38f0dcf | CLOUDFLARE_API_TOKEN_ARTIFICIALMINDHIVE |

An explicit matching account ID selects the same route. Existing aliases are unchanged. The additional credential is a Worker encrypted secret on cloudflare-ops-mcp, never a tool argument, repository file, plain variable, or federation credential.

Owner/admin calls to Pages deploy, inspect, patch, rollback and create/add-domain tools use the new secret for the additional account. Missing additional credential fails closed. Shared Worker/D1 setup does not use it. Existing dry-run defaults and protected-project behavior remain unchanged. Routing does not grant Cloudflare permissions or establish that a supplied token is valid.

The current runtime authenticates MCP_ACCESS_KEY, MCP_EXTRA_ADMIN_KEYS and WALO_BOARD_KEY as admin. MCP OAuth grants backed by these WT keys inherit their existing capabilities. Ordinary per-user Cloudflare OAuth and wtu connections do not obtain this shared credential.

Update both worker/live/index.js and worker/mcp-oauth/base-live.mjs when changing legacy runtime behavior; src/pages-deploy.js retains the reusable alias definitions. The generated live bundle includes the OAuth wrapper and current WALO authentication. Preserve these when publishing. The older build baseline has pre-existing differences from the generated bundle, so do not blindly rebuild and deploy it without reconciling the current production baseline.

Run `node --test test/pages-account-routing.test.js`.

These tests exercise both the generated runtime and build baseline with fixture credentials and mocked network calls. They check exact account selection, tenant isolation, missing-secret failures, unchanged existing routes and create dry-run behavior. They do not use real credentials or deploy anything.

Repository release-gates CI runs tests; it does not deploy the Worker. Follow worker/mcp-oauth/README.md for release reconciliation, preserve existing bindings/assets and compatibility flags, and enforce a fresh live ETag precondition.
