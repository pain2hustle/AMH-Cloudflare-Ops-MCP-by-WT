# Approved WALO notification diagnostics
Adds one owner-only tool for two fixed Workers in Austin Doors. It embeds only the reviewed notification diagnostics edits; no arbitrary code, paths, account selection, credential changes or messages.
Requires the existing server admin authorizer, excludes OAuth connections and the WALO integration principal, preserves outer MCP policy checks, and requires scoped approval. Both general executor block policies remain unchanged.
Inspection reports hashes and rollback version; settings values and source stay private. Staging checks the selected live snapshot, preserves all other modules/runtime/bindings/secrets and verifies uploaded bytes. Durable Object receipts prevent duplicate uploads/deploys. Uncertain outcomes require status/read verification, never automatic resend. Rollback is guarded against concurrent deployment.
22 actual capability mock tests and 125 existing WALO/diagnostic tests passed with network mocked/disabled. Existing live MCP bundle is preserved exactly except module insertion, tool catalog entry and dispatch.
Base shared MCP version: 656bc546-a12a-4231-8b76-61a9a8cd4356; SHA256 2c9e36fa8c985c613f3ba34ab46efa07206b4ac9f3bde1545b44cbe2c5c12451.
WALO source is separately inspected at runtime; staging stops on changed patch anchors or any source/config drift. No handset delivery is inferred from HTTP acceptance.
