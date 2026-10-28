var READING_TTL = 7 * 86400;
var PAGE_TTL = 300;
var PAGE_CACHE_REVISION = "20261011-reviewed-guides-final";
function cacheTtlFor(pathname) {
  if (pathname.startsWith("/community/reading/")) return READING_TTL;
  if (pathname === "/community/reading" || pathname.startsWith("/community/library")) return PAGE_TTL;
  if (pathname.startsWith("/api/")) return 0;
  if (pathname.startsWith("/_next/")) return 0;
  if (pathname.startsWith("/dashboard")) return 0;
  if (pathname.startsWith("/live")) return 0;
  return PAGE_TTL;
}
__name(cacheTtlFor, "cacheTtlFor");
function cacheable(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return 0;
  if (request.headers.has("cookie")) return 0;
  if (request.headers.has("rsc") || request.headers.has("next-router-state-tree")) return 0;
  if (request.headers.get("cache-control") === "no-cache" && request.headers.has("x-apiary-bust")) return 0;
  return cacheTtlFor(url.pathname);
}
__name(cacheable, "cacheable");
var apiaryWorker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const redirected = readingRedirect(url.pathname) || driveArticleRedirect(url.pathname);
    if (redirected && (request.method === "GET" || request.method === "HEAD")) {
      return Response.redirect(new URL(redirected, url.origin).href, 301);
    }
    if (isRetiredReading(url.pathname)) {
      return new Response(request.method === "HEAD" ? null : "This article was removed. Browse the Library at /community/reading.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
      });
    }
    const ttl = cacheable(request, url);
    if (!ttl) return worker_default.fetch(request, env, ctx);
    const cache = caches.default;
    const cacheUrl = new URL("https://apiarybee.com" + url.pathname + url.search);
    const rev = readingRevision(url.pathname);
    cacheUrl.searchParams.set("__apiary_revision", rev ? `${PAGE_CACHE_REVISION}-${rev}` : PAGE_CACHE_REVISION);
    const key = new Request(cacheUrl, { method: "GET" });
    const hit = await cache.match(key);
    if (hit) {
      const h2 = new Headers(hit.headers);
      h2.set("x-apiary-edge", "HIT");
      return new Response(request.method === "HEAD" ? null : hit.body, { status: hit.status, headers: h2 });
    }
    const isReading = url.pathname.startsWith("/community/reading/") && !url.search;
    const r2Key = isReading ? cacheUrl.pathname.slice(1) + "@" + cacheUrl.searchParams.get("__apiary_revision") : null;
    if (r2Key && env.READING_HTML) {
      try {
        const obj = await env.READING_HTML.get(r2Key);
        if (obj) {
          const h2 = new Headers();
          h2.set("content-type", obj.httpMetadata?.contentType || "text/html; charset=utf-8");
          h2.set("cache-control", `public, max-age=0, s-maxage=${ttl}`);
          h2.set("x-apiary-edge", "R2");
          const buf2 = await obj.arrayBuffer();
          ctx.waitUntil(cache.put(key, new Response(buf2, { status: 200, headers: h2 })));
          return new Response(request.method === "HEAD" ? null : buf2, { status: 200, headers: h2 });
        }
      } catch (e) {
      }
    }
    const resp = await worker_default.fetch(request, env, ctx);
    if (isReading && resp.status === 404 && !resp.headers.has("set-cookie")) {
      const h2 = new Headers(resp.headers);
      h2.set("cache-control", "public, max-age=0, s-maxage=3600");
      h2.set("x-apiary-edge", "MISS-404");
      const buf2 = await resp.arrayBuffer();
      ctx.waitUntil(cache.put(key, new Response(buf2, { status: 404, headers: h2 })));
      return new Response(request.method === "HEAD" ? null : buf2, { status: 404, headers: h2 });
    }
    if (resp.status !== 200 || resp.headers.has("set-cookie")) {
      const h2 = new Headers(resp.headers);
      h2.set("x-apiary-edge", "BYPASS");
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h2 });
    }
    const h = new Headers(resp.headers);
    h.set("cache-control", `public, max-age=0, s-maxage=${ttl}`);
    h.set("x-apiary-edge", "MISS");
    const buf = await resp.arrayBuffer();
    const stored = new Response(buf, { status: 200, headers: h });
    ctx.waitUntil(cache.put(key, stored.clone()));
    if (r2Key && env.READING_HTML) {
      ctx.waitUntil(env.READING_HTML.put(r2Key, buf, {
        httpMetadata: { contentType: h.get("content-type") || "text/html; charset=utf-8" }
      }).catch(() => {
      }));
    }
    return new Response(request.method === "HEAD" ? null : buf, { status: 200, headers: h });
  }
};
var apiary_entry_default = withPageCounts(apiaryWorker, client_source_default);