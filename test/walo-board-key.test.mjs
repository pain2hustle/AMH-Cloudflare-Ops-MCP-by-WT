import test from "node:test"; import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const src = readFileSync(new URL("../worker/live/index.js", import.meta.url), "utf8")
  .replace('import { WorkerEntrypoint } from "cloudflare:workers";', "class WorkerEntrypoint { constructor(c, e) { this.ctx = c; this.env = e; } }");
const f = join(mkdtempSync(join(tmpdir(), "wt-")), "bundle.mjs"); writeFileSync(f, src);
const w = (await import(f)).default;
const env = { WALO_BOARD_KEY: "walo-test-key-0123", MCP_ACCESS_KEY: "admin-test-key" };
const call = (key) => w.fetch(new Request("https://mcp.example/board/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, action: "nope" }) }), env, { waitUntil() {} });
test("board/api: WALO_BOARD_KEY passes auth", async () => assert.equal((await call("walo-test-key-0123")).status, 400));
test("board/api: MCP_ACCESS_KEY still passes", async () => assert.equal((await call("admin-test-key")).status, 400));
test("board/api: wrong key rejected", async () => assert.equal((await call("bad")).status, 401));
test("board/api: empty key rejected", async () => assert.equal((await call("")).status, 401));
