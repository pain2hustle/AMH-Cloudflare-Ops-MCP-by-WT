import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";

test("worker GET advertises broad Cloudflare Ops tool catalog", async () => {
  const res = await worker.fetch(new Request("https://example.test/"), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.server.title, "AMH Walrus Tusk Cloudflare Ops MCP — SafeTry Agent Harness");
  assert.equal(body.server.version, "0.5.3");
  for (const tool of [
    "scan_zone",
    "apply_dns_record",
    "delete_dns_record",
    "setup_email_routing",
    "pages_cutover",
    "purge_cache",
    "create_turnstile_widget",
  ]) {
    assert.ok(body.tools.includes(tool), `missing ${tool}`);
  }
});
test("worker browser status page uses green OAuth connect UI", async () => {
  const res = await worker.fetch(new Request("https://example.test/", { headers: { accept: "text/html" } }), {
    MCP_ACCESS_KEY: "test-key",
    CLOUDFLARE_OAUTH_CLIENT_ID: "client-id",
    CLOUDFLARE_OAUTH_CLIENT_SECRET: "client-secret",
    CLOUDFLARE_OAUTH_REDIRECT_URI: "https://example.test/oauth/cloudflare/callback",
    CLOUDFLARE_OPS_OAUTH: { get: async () => null, put: async () => {}, delete: async () => {} },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /#6ee7a3/);
  assert.match(html, /Connect Cloudflare/);
  assert.match(html, /no shared API token/i);
  assert.match(html, /AMH|M H/);
  assert.match(html, /Per-user keys/i);
});

test("worker serves the AMH-only WT bundle at the browser root", async () => {
  const expected = "<!doctype html><title>AMH Cloudflare Ops MCP by WT</title><a href='/oauth/cloudflare/start'>Connect Cloudflare</a>";
  const requested = [];
  const res = await worker.fetch(new Request("https://mcp.artificialmindhive.com/", {
    headers: { accept: "text/html" },
  }), {
    ASSETS: {
      fetch: async (request) => {
        requested.push(new URL(request.url).pathname);
        return new Response(expected, { headers: { "content-type": "text/html" } });
      },
    },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(requested, ["/WT-MCP-Root.html"]);
  assert.equal(await res.text(), expected);
  assert.match(res.headers.get("content-security-policy"), /script-src[^;]*'unsafe-inline'[^;]*blob:/);
  assert.doesNotMatch(expected, /nothingunseen/i);
});

test("worker publishes Walrus Tusk search and AI discovery resources", async () => {
  const origin = "https://mcp.artificialmindhive.com";
  const cases = [
    ["/robots.txt", /Sitemap: https:\/\/mcp\.artificialmindhive\.com\/sitemap\.xml/],
    ["/sitemap.xml", /walrus-tusk\.md/],
    ["/llms.txt", /AMH Walrus Tusk Cloudflare Ops MCP/],
    ["/walrus-tusk.md", /Walrus Tusk \(WT\)/],
    ["/d4f02a51e05cfee056bc027685262a64.txt", /^d4f02a51e05cfee056bc027685262a64$/],
  ];

  for (const [path, pattern] of cases) {
    const res = await worker.fetch(new Request(origin + path), {});
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), pattern, path);
  }
});
