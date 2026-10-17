import OAuthProvider, { AuthorizationError, CimdFetchError, OAuthError, insufficientScope } from '@cloudflare/workers-oauth-provider';

export const ORIGIN = 'https://mcp.artificialmindhive.com';
export const RESOURCE = ORIGIN + '/mcp';
const SCOPE = 'wt:operate';
const PREFIX = 'mcp-oauth-v1:';
const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');

// Reuse the existing namespace without colliding with its Cloudflare grants.
export function prefixedKV(kv) {
  return {
    get: (key, options) => kv.get(PREFIX + key, options),
    put: (key, value, options) => kv.put(PREFIX + key, value, options),
    delete: key => kv.delete(PREFIX + key),
    async list(options = {}) {
      const result = await kv.list({ ...options, prefix: PREFIX + (options.prefix || '') });
      return { ...result, keys: result.keys.map(k => ({ ...k, name: k.name.slice(PREFIX.length) })) };
    },
  };
}

function page(details, handle) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Walrus Tusk · AMH</title>
<style>*{box-sizing:border-box}body{margin:0;background:#07110e;color:#ecfff5;font:17px/1.5 system-ui;min-height:100svh;display:grid;place-items:center;padding:24px}main{width:min(100%,520px);padding:28px;border:1px solid #315e46;border-radius:24px;background:#101e18}small{color:#99d7b5}h1{font-size:30px;line-height:1.15}p{overflow-wrap:anywhere}label{display:block;margin-top:24px}input{width:100%;padding:15px;margin:8px 0 18px;border:1px solid #59856b;border-radius:10px;background:#07110e;color:white;font:inherit}button{min-height:48px;padding:12px 20px;border:0;border-radius:12px;font:700 16px system-ui;cursor:pointer}button[value=approve]{background:#82ffae;color:#062013}button[value=deny]{background:#24372d;color:white}a{color:#82ffae}.actions{display:flex;gap:12px;flex-wrap:wrap}</style>
<main><small>AMH / WALRUS TUSK / CF OPS</small><h1>Connect ${escape(details.clientName)}</h1>
<p>Access will return to <strong>${escape(details.redirectHost)}</strong>.</p>
<p>${details.clientDomain ? `App identity: <strong>${escape(details.clientDomain)}</strong>.` : 'The app supplied its name; check the destination above.'}${details.redirectIsLoopback ? ' This connects an app running on your computer.' : ''}</p>
<p>Allow this app to use your Walrus Tusk tools, including changes to connected sites and repositories, within the permissions of your key. Existing tool approval rules still apply.</p>
<p><small>Requested access: ${details.scope.map(escape).join(', ') || SCOPE}. Your key stays on this server; the app receives separate, revocable access.</small></p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="handle" value="${escape(handle)}"><label for="key">Your Walrus Tusk connection key</label><input id="key" name="key" type="password" autocomplete="current-password" placeholder="Paste your WT connection key" maxlength="1024"><div class="actions"><button name="decision" value="approve">Allow connection</button><button name="decision" value="deny">Cancel</button></div></form>
<p><small>Use the same private key as your working WT connection. Never paste your Cloudflare API token here.</small></p><a href="/setup" target="_blank" rel="noopener noreferrer">Walrus Tusk setup</a></main></html>`;
}

export function createOAuthWorker(legacy, authorizeConnector) {
  const defaultHandler = {
    async fetch(request, env, ctx) {
      if (new URL(request.url).pathname !== '/oauth/authorize') return legacy.fetch(request, env, ctx);
      const oauth = env.OAUTH_PROVIDER;
      try {
        if (request.method === 'GET') {
          const parsed = await oauth.parseAuthRequest(request);
          // Both public and confidential clients must use S256 for this connector.
          if (!parsed.codeChallenge || parsed.codeChallengeMethod !== 'S256') return json({ error: 'invalid_request', error_description: 'S256 PKCE is required.' }, 400);
          const details = await oauth.describeConsent(parsed);
          const consent = await oauth.beginConsent(parsed);
          consent.headers.set('Content-Type', 'text/html; charset=utf-8');
          // Chromium also checks form-action on redirects after a same-origin POST.
          // The library already validated this exact client callback URI.
          consent.headers.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(parsed.redirectUri).origin}; base-uri 'none'; frame-ancestors 'none'`);
          consent.headers.set('Referrer-Policy', 'same-origin');
          return new Response(page(details, consent.handle), { headers: consent.headers });
        }
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
        if (request.headers.get('origin') !== ORIGIN) return json({ error: 'invalid_request', error_description: 'Open this connection from your app again.' }, 403);
        const form = await request.formData();
        const handle = String(form.get('handle') || '');
        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const key = String(form.get('key') || '').trim();
        const auth = key.length <= 1024 ? await authorizeConnector(env, key) : { ok: false };
        if (!auth.ok) return new Response('That WT connection key was not accepted. Go back and try your existing WT key.', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
        const approved = await oauth.approveConsent(request, handle);
        const scope = [...new Set([...approved.request.scope, SCOPE])];
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request, userId: await digest(key), scope,
          metadata: { provider: 'Walrus Tusk', mode: auth.mode },
          // The library encrypts props under a grant-specific key, wrapped by OAuth credentials.
          props: { connectorKey: key },
        });
        approved.headers.set('Location', redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      } catch (error) {
        if (error instanceof AuthorizationError && error.redirectTo && request.method === 'GET') return Response.redirect(error.redirectTo, 302);
        if (error instanceof AuthorizationError || error instanceof CimdFetchError) return json({ error: 'invalid_request', error_description: 'This connection request expired or could not be verified. Start again from your app.' }, 400);
        throw error;
      }
    },
  };
  const provider = new OAuthProvider({
    apiRoute: '/mcp',
    apiHandler: {
      async fetch(request, env, ctx) {
        // Every issued OAuth token must carry the approved tool scope.
        if (ctx.auth && !ctx.auth.scope.includes(SCOPE)) return insufficientScope(ctx.auth, [SCOPE]);
        if (!ctx.props?.connectorKey) return json({ error: 'invalid_token' }, 401);
        const headers = new Headers(request.headers);
        headers.set('authorization', 'Bearer ' + ctx.props.connectorKey);
        // Legacy auth runs again on every call, so key revocation still takes effect.
        return legacy.fetch(new Request(request, { headers }), env, ctx);
      },
    },
    defaultHandler,
    authorizeEndpoint: ORIGIN + '/oauth/authorize',
    tokenEndpoint: ORIGIN + '/oauth/token',
    clientRegistrationEndpoint: ORIGIN + '/oauth/register',
    resourceMetadata: { resource: RESOURCE, authorization_servers: [ORIGIN], resource_name: 'AMH Walrus Tusk CF Ops MCP' },
    scopesSupported: [SCOPE, 'offline_access'], requiredScopes: [SCOPE],
    accessTokenTTL: 3600, refreshTokenTTL: 2592000, refreshTokenIdleTTL: 2592000,
    clientIdMetadataDocumentEnabled: true,
    async tokenExchangeCallback({ props, env }) {
      if (!props?.connectorKey || !(await authorizeConnector(env, props.connectorKey)).ok) throw new OAuthError('invalid_grant', { description: 'The underlying WT connection was revoked.' });
    },
    onError(error) { console.warn(JSON.stringify({ event: 'mcp_oauth_error', code: error.code, reason: error.internal?.reason })); },
  });
  return {
    scheduled: legacy.scheduled,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const oauthRoute = ['/oauth/authorize', '/oauth/token', '/oauth/register'].includes(url.pathname);
      const discovery = url.pathname.startsWith('/.well-known/oauth-');
      const mcp = url.pathname === '/mcp' || url.pathname.startsWith('/mcp/');
      if (!oauthRoute && !discovery && !mcp) return legacy.fetch(request, env, ctx);
      try {
        // Older connectors probe the root document instead of the RFC 9728 path suffix.
        if (url.pathname === '/.well-known/oauth-protected-resource') {
          url.pathname = '/.well-known/oauth-protected-resource/mcp';
          request = new Request(url, request);
        }
        if (oauthRoute && env.RATE_LIMITER) {
          const ip = request.headers.get('cf-connecting-ip') || 'unknown';
          const result = await env.RATE_LIMITER.limit({ key: 'mcp-oauth:' + await digest(ip) });
          if (!result.success) return new Response('Please wait before trying again.', { status: 429, headers: { 'retry-after': '60' } });
        }
        if (oauthRoute && request.method === 'POST') {
          const reader = request.body?.getReader(); let size = 0; const chunks = [];
          if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) { await reader.cancel(); return json({ error: 'request_too_large' }, 413); } chunks.push(value); }
          request = new Request(request, { body: new Blob(chunks) });
        }
        if (mcp && !request.headers.has('authorization')) {
          const key = request.headers.get('x-mcp-key') || url.searchParams.get('key');
          if (key) { const headers = new Headers(request.headers); headers.set('authorization', 'Bearer ' + key); request = new Request(request, { headers }); }
        }
        // Keep all existing bearer/header/query-key clients, including the Workers alias.
        if (mcp) {
          const supplied = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
          if (supplied && (await authorizeConnector(env, supplied)).ok) return legacy.fetch(request, env, ctx);
        }
        // Request-local env: never mutate shared bindings or store credentials in globals.
        return await provider.fetch(request, { ...env, OAUTH_KV: prefixedKV(env.CLOUDFLARE_OPS_OAUTH) }, ctx);
      } catch {
        console.error(JSON.stringify({ event: 'mcp_oauth_unavailable' }));
        return json({ error: 'temporarily_unavailable', error_description: 'Connection service unavailable. Please try again.' }, 503);
      }
    },
  };
}
