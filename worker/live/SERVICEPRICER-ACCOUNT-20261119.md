# Servicepricer account available to owner/agent MCP clients

Live on 2026-11-19. `account: "servicepricer"` resolves to account `068a8123b10b7a9fcdcb49e6763969e9` (Servicepricerapp@gmail.com), which owns `souljaboy-app` and `souljaboy.app`.

The credential is an encrypted Worker secret named `CLOUDFLARE_API_TOKEN_SERVICEPRICER` on the existing `cloudflare-ops-mcp` Worker in the pain2hustle1 account. The value is not in this repository, deployment receipts, tool schemas, or agent messages. Use Cloudflare dashboard Worker Settings > Variables and Secrets to replace the secret when rotating it.

Use existing `pages_deploy`, `pages_patch`, deployment inspection, rollback, special-file, and Pages setup tools with `account: "servicepricer"`. `account_doctor` and `pages_branch_check` accept its account ID. Writes retain their existing dry-run/apply behavior. The shared credential follows the existing owner/admin gate; OAuth/tenant users cannot select it. This account addition does not enable raw API federation, Worker creation, or D1 tools with this secret.

Verified through the live MCP: account identity, current Soulja Boy deployment, production-branch check, and unchanged Doors account access. Local exact-helper integration verified account routing, missing-secret failure and tenant isolation. All prior bindings were retained. The Worker implements a Durable Object, so Cloudflare does not generate a version URL; no hosted-preview pass is claimed.

- Released version: `77548fe3-89e3-49ca-94bc-0d1ea6ffa075`
- Rollback version (secret already stashed): `3d64c6e2-98af-4b13-bbe0-f381749b199f`
- Deployment: `51ab046d-1765-4d4b-af60-f3ce6d96cf44`
- Exact candidate SHA-256: `39b94771c588e1dbd2b4fbd339ae52e90a6a284c7bb43bec129c3a68de2882ba`
- Local backup, candidate, checks and receipts: `D:/agent-work/mcp-servicepricer-token-20261119`

Future hub changes must download the current live bundle first, as required by this directory's README. Do not deploy the older modular source or overwrite an agent's dirty live bundle. `patch-servicepricer-account.mjs` records the narrowly scoped transformation and isolation checks against the preceding live bundle. It writes a candidate and fails if its anchors are missing/already applied. It contains no credentials.
