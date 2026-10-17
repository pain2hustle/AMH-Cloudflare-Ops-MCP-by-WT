# ChatGPT / MCP OAuth connection

Connection URL: https://mcp.artificialmindhive.com/mcp

Choose OAuth in the client. Leave optional client ID and secret empty to use dynamic registration. CIMD is also supported, including ChatGPT's published client metadata. On the WT approval page use an existing private WT connection key (not a Cloudflare API token). Approval gives the app that key's existing permissions through separate OAuth access and refresh tokens. No connection key is sent to the client.

## Implementation

- Cloudflare workers-oauth-provider 1.2.3: protected-resource and authorization-server metadata, DCR, CIMD, S256 PKCE, browser-bound consent, authorization-code exchange, refresh, revocation, issuer identification and exact resource binding.
- Resource and issuer are fixed to the canonical MCP domain. Both root and /mcp resource discovery URLs work.
- OAuth props contain the underlying key encrypted by the provider. Every tool request still runs the existing key authorization and permission checks. Revoked WT keys stop OAuth tool use and refresh.
- One-hour access tokens and 30-day refresh idle lifetime. Scope wt:operate grants the existing key's tool capabilities. This is not a separate read-only role.
- Existing Bearer, X-MCP-Key and query-key connections, including the workers.dev alias, retain their original path.
- No database, AI calls, cron, or new binding. OAuth records use prefix mcp-oauth-v1: in the existing CLOUDFLARE_OPS_OAUTH KV. All 18 bindings and Worker assets were preserved. Added compatibility flag global_fetch_strictly_public for safe CIMD fetching.
- KV has eventual consistency. Credential revocation is checked on every request but follows Cloudflare KV propagation; this is not a promise of globally atomic revocation.

## Build and release

From this directory run npm ci, npm test, then npm run build. The generated release is ../live/index.js. base-live.mjs is the exact production source recovered before this change, retaining live changes newer than the previous Git copy. build.mjs exports its authorization helper and bundles it with the wrapper. Never substitute the older worker/index.js modular entry.

Before later changes, fetch the current live source and compare its etag, reconcile any other agent's changes, and preserve all bindings/assets when uploading. Do not replace the base with an already wrapped bundle. The 2026-10-17 release was made with an etag guard through the Workers API; no Pages project was deployed.

Local security checks are in tests.json. Live verification uses a temporary test OAuth client and revokes its grant afterward. It exercises the phone consent page, actual ChatGPT CIMD lookup, code exchange, initialize, tools/list, refresh, legacy connection and static landing/setup. Real ChatGPT app connection remains a user sign-in step; a successful synthetic flow is not a claim that the user's app has been connected.

No always-on work was added. The original Worker's existing audit behavior was preserved.
