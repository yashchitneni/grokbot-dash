// Private office HTTP edge. Static UI and /api/* both require a checked user.
// Machine ingest requires a checked service credential. Nothing here trusts an email header by itself.

import {
  authenticateIngest,
  authenticateUser,
  sessionCookie,
  signSession,
} from './auth.js';

const MAX_BODY = 4096;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

export function loginHtml(allowBearer) {
  const form = allowBearer
    ? `<form method="post" action="api/login">
        <label>Harness token <input name="token" type="password" autocomplete="current-password" required></label>
        <button type="submit">Sign in</button>
      </form>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Sign in</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1c1c1e; color: #f2f2f7;
      font: 16px/1.45 ui-rounded, system-ui, sans-serif; }
    main { width: min(420px, calc(100% - 32px)); padding: 28px; border-radius: 20px; background: #2c2c2e; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { margin: 0 0 12px; color: #c8c8ce; }
    form { display: grid; gap: 10px; }
    input { font: inherit; padding: 8px 10px; border-radius: 10px; border: 0; }
    button { font: inherit; padding: 8px 12px; border: 0; border-radius: 999px; background: #f2f2f7; }
  </style>
</head>
<body>
  <main>
    <h1>Private office</h1>
    <p>The office and its feed are signed in. Cloudflare Access signs the browser in at the edge. This page has no feed address and no write credential.</p>
    <p>Unread chat is not ingested. Bots post to the authenticated ingest endpoint with a service credential that is not stored in this page.</p>
    ${form}
  </main>
</body>
</html>`;
}

function loginResponse(env, status = 401) {
  const allow = env.ALLOW_BEARER_LOGIN === '1';
  return new Response(loginHtml(allow), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    },
  });
}

function wantsDocument(request) {
  const dest = request.headers.get('sec-fetch-dest');
  if (dest === 'document' || dest === 'iframe') return true;
  return (request.headers.get('accept') || '').includes('text/html');
}

function route(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  const api = path.startsWith('/office/api/') ? path.slice('/office'.length) : path;
  return { path, api };
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

async function officeStub(env) {
  const id = env.OFFICE.idFromName('private');
  return env.OFFICE.get(id);
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY) return { error: 'too_large' };
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: 'too_large' };
  try {
    const rec = JSON.parse(text);
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { error: 'bad_json' };
    return { rec };
  } catch {
    return { error: 'bad_json' };
  }
}

function stamp(rec) {
  const now = new Date().toISOString();
  if (typeof rec.t === 'string' && Number.isFinite(Date.parse(rec.t))) {
    const ms = Date.parse(rec.t);
    if (ms < Date.now() + 86400e3) return rec.t;
  }
  return now;
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const { path, api } = route(url.pathname);

  if (api === '/api/health') return json({ ok: true, auth: 'required' });

  if (api === '/api/ingest') {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    if (!sameOrigin(request)) return json({ error: 'unauthorized' }, 403);
    const actor = await authenticateIngest(request, env);
    if (!actor) {
      const user = await authenticateUser(request, env);
      return json({ error: 'unauthorized' }, user ? 403 : 401);
    }
    const parsed = await readJson(request);
    if (parsed.error === 'too_large') return json({ error: 'too_large' }, 413);
    if (parsed.error) return json({ error: 'bad_json' }, 400);
    const at = stamp(parsed.rec);
    const stub = await officeStub(env);
    const res = await stub.fetch('https://office.internal/ingest', {
      method: 'POST',
      body: JSON.stringify({ rec: parsed.rec, at }),
    });
    const result = await res.json();
    return json({ ok: true, result }, res.status);
  }

  if ((path === '/login' || path === '/office/login') && request.method === 'GET') return loginResponse(env);

  if (api === '/api/login' && request.method === 'POST') {
    if (env.ALLOW_BEARER_LOGIN !== '1') return json({ error: 'unauthorized' }, 401);
    if (!sameOrigin(request)) return json({ error: 'unauthorized' }, 403);
    let presented = request;
    const type = request.headers.get('content-type') || '';
    if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
      const form = await request.formData();
      const token = String(form.get('token') || '');
      presented = new Request(request.url, { headers: { authorization: `Bearer ${token}` } });
    }
    const user = await authenticateUser(presented, env);
    if (!user || user.method === 'session') return json({ error: 'unauthorized' }, 401);
    return await sessionResponse(env, user);
  }

  const user = await gateSession(request, env);
  if (!user) {
    if (api.startsWith('/api/')) return json({ error: 'unauthorized' }, 401);
    if (wantsDocument(request) || path === '/' || path === '/office') return loginResponse(env);
    return json({ error: 'unauthorized' }, 401);
  }

  if (api === '/api/logout' && request.method === 'POST') {
    if (!sameOrigin(request)) return json({ error: 'unauthorized' }, 403);
    await currentGen(env, true);
    return json(
      { ok: true, access_logout: '/cdn-cgi/access/logout' },
      200,
      { 'set-cookie': sessionCookie('', 0) },
    );
  }

  if (api === '/api/office' && request.method === 'GET') {
    return json({ private: true, ingestion: 'authenticated' });
  }

  if (api === '/api/session' && request.method === 'GET') {
    return json({ email: user.email, method: user.method });
  }

  const resolve = /^\/api\/requests\/([^/]+)\/resolve$/.exec(api);
  if (resolve && request.method === 'POST') {
    if (!sameOrigin(request)) return json({ error: 'unauthorized' }, 403);
    const id = decodeURIComponent(resolve[1]);
    const stub = await officeStub(env);
    const res = await stub.fetch('https://office.internal/resolve', {
      method: 'POST',
      body: JSON.stringify({ id, by: user.email || 'user', at: new Date().toISOString() }),
    });
    const result = await res.json();
    return json({ ok: true, result }, result.resolved ? 200 : 404);
  }

  if (api === '/api/state' && request.method === 'GET') {
    const stub = await officeStub(env);
    const res = await stub.fetch('https://office.internal/snapshot');
    const state = await res.json();
    state.auth = { email: user.email, method: user.method };
    return json(state);
  }

  if (api.startsWith('/api/')) return json({ error: 'not_found' }, 404);

  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return json({ error: 'not_found' }, 404);
  const assetUrl = new URL(request.url);
  if (path === '/' || path === '/office') assetUrl.pathname = '/office/index.html';
  const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  const headers = new Headers(asset.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.append('content-security-policy', "connect-src 'self'; frame-ancestors 'none'");
  return new Response(asset.body, { status: asset.status, headers });
}

async function currentGen(env, bump) {
  const stub = await officeStub(env);
  const res = await stub.fetch('https://office.internal/session-gen', { method: bump ? 'POST' : 'GET' });
  const body = await res.json();
  return Number(body.gen) || 0;
}

async function gateSession(request, env) {
  const user = await authenticateUser(request, env);
  if (!user || user.method !== 'session') return user;
  const gen = await currentGen(env, false);
  if (gen !== user.gen) return null;
  return user;
}

async function sessionResponse(env, user) {
  if (typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 16) {
    return json({ error: 'misconfigured' }, 500);
  }
  const exp = Date.now() + 12 * 3600e3;
  const gen = await currentGen(env, false);
  const token = await signSession({ email: user.email, exp, method: user.method, gen }, env.SESSION_SECRET);
  return json({ ok: true, email: user.email }, 200, { 'set-cookie': sessionCookie(token, 12 * 3600) });
}
