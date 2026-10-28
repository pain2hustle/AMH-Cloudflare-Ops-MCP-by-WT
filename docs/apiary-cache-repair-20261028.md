# Apiary cache repair — 2026-10-28

A cold HEAD request could persist an empty successful page under a GET cache key. The deployed patch renders the GET representation on cache misses, ignores empty cached pages, avoids storing empty responses, and preserves bodyless HEAD responses.

Production Worker: apiary-bee. Active version: e6dce750-5b9a-4b5e-aec6-eb9916f4563c. Deployment: 6846a913-9133-477f-a2e7-c863d400ef7b. Verified at 2026-10-28T20:35:17.676Z. Rollback version: 0a4b44d7-f34b-4ca1-9637-248373c80de3.

The existing cache revision stays 20261011-reviewed-guides-final. All 23,301 expected current cache objects were present and nonempty before deployment. No cache deletion, purge, rebuild, new credential, or namespace migration occurred.

Verification: 17 cache behavior tests; 19 repair/authorization/version-guard tests; complete compiled Worker tested locally with three cold HEAD-to-GET scenarios; production initial three HEAD/GET pairs and 30 representative canonical HEAD/GET pairs passed. Full runtime exports, bindings, assets, settings and unchanged source-map hash were verified. The uploaded source SHA-256 is ad81792693040ff58364093c700c2ac8f15e8ee45dc38f3364352dc2cbce3981.

The owner-only fixed-resource operation is embedded in worker/live/index.js; its readable companion is apiary-cache-repair.js. It accepts no caller-supplied resource or code. Existing policy enforcement, OAuth wrapper, tenant isolation and WALO boundaries remain. Generic cf__execute and cfdoors__execute remain blocked. MCP version 656bc546-a12a-4231-8b76-61a9a8cd4356, source SHA-256 2c9e36fa8c985c613f3ba34ab46efa07206b4ac9f3bde1545b44cbe2c5c12451.

Initial staging omitted exports and was never deployed. A corrected upload preserved them; a transient provider read error was recovered by verifying that same uploaded version. The operation records the deployed version and supports rollback only while that exact repair version remains active.

Run: node --test tests/apiary-cache-repair.test.mjs tests/apiary-cache-behavior.test.mjs

Limit: the historical Search Console report (~3,400 5xx URLs) has not been revalidated by Google. The bug is fixed; its contribution to all historical failures is not established. The 30-page sample is not a replay of the unavailable historical error export. Private code/settings backups and receipts remain in the operator's repair workspace and are intentionally absent from Git.
