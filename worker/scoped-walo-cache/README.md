# Approved tenant 1 sender cache repair
Extends the existing owner-only WALO diagnostic tool with sender_cache_inspect, sender_cache_apply and sender_cache_verify. Uses the existing admin authorizer and policy wrapper; excludes WALO integration principals and OAuth connections. Both general executor block policies remain unchanged.

Fixed scope: Austin Doors, localops-whatsapp-bridge, current verified diagnostic version e0845984-a3b3-462f-860d-bed7d1ea6cf7, DB localops 203fa727-30e1-4e07-b6a3-0aeefac08412, tenant 1, its two existing relay_key_hash routes, and only their current/backup CHAT cache entries. The namespace is derived from the verified live CHAT binding. No arbitrary account, namespace, key, SQL, source or credentials are accepted.

Inspection verifies the live DB binding, complete source hash and both tenant resolver functions, the exact production SELECT against both routes, the active tenant and replacement sender, and exact owner-set equality between each cache entry and D1. Owner phone numbers, route hashes, cached credentials and metadata values never appear in results.

Apply requires the exact inspected fingerprint and confirmation. Only sender 1258784447309850 may become 1399264479939553. The raw JSON is changed at one unique sender field; every other byte remains unchanged. Metadata and absolute expiration are preserved. A stale entry expiring within 65 seconds is individually invalidated instead of extending its TTL. Other entries/tenants are untouched. The durable ledger snapshots before sender IDs/content/metadata hashes and tracks each attempted write; uncertain outcomes never automatically retry.

KV updates can require up to 60 seconds to propagate. Verification is separate and read-only. No messages, OAuth changes, new secrets, registrations, Worker routing changes or broad purge.

Validation: 22 cache-specific mock tests plus 25 existing diagnostic safeguard tests pass. Source inversion verifies that only this extension differs from the previous live MCP bundle. Base shared MCP version b5e328a5-9692-4aff-9e58-12600b865b7c; source SHA256 b5af6e447e702c1840f9ced53235651e9ec6165f085f5d2d29e75a2df5eb33ff.
