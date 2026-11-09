import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Office } from '../src/do.js';
import { handle, loginHtml } from '../src/worker.js';
import { deleteMessagesMatching } from '../src/store.js';

const USER = 'test-user-token-0123456789';
const INGEST = 'test-ingest-token-0123456789';
const SESSION = 'test-session-secret-0123456789';
const SERVICE_ID = 'service-client-id-0123456789';
const SERVICE_SECRET = 'service-client-secret-0123456789';
const WEEKLY = 'weekly review';
const WORKOUT = 'evening workout';

function nodeSql(db) {
  return {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|WITH)\b/i.test(query)) {
        const rows = stmt.all(...params);
        return { toArray: () => rows, one: () => rows[0] ?? null };
      }
      stmt.run(...params);
      return { toArray: () => [], one: () => null };
    },
  };
}

function memoryOffice() {
  const db = new DatabaseSync(':memory:');
  const sql = nodeSql(db);
  const office = new Office({ storage: { sql }, blockConcurrencyWhile: (fn) => fn() });
  return office;
}

function testEnv(office = memoryOffice()) {
  return {
    USER_TOKEN: USER,
    INGEST_TOKEN: INGEST,
    SESSION_SECRET: SESSION,
    ALLOW_BEARER_LOGIN: '1',
    ACCESS_AUD: 'office-aud',
    ACCESS_TEAM_DOMAIN: 'team.example.cloudflareaccess.com',
    ACCESS_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
    ACCESS_SERVICE_CLIENT_ID: SERVICE_ID,
    ACCESS_SERVICE_CLIENT_SECRET: SERVICE_SECRET,
    OFFICE: {
      idFromName() { return 'private'; },
      get() { return office; },
    },
    ASSETS: {
      async fetch() {
        return new Response('<!doctype html><title>Office</title><p>Office shell</p>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    },
    _office: office,
  };
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
publicJwk.kid = 'test-key';
publicJwk.alg = 'RS256';

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function makeJwt(payload, kid = 'test-key') {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = sign('RSA-SHA256', Buffer.from(data), privateKey);
  return `${data}.${b64url(sig)}`;
}

function call(env, path, { method = 'GET', token, headers = {}, body, accept } = {}) {
  const h = new Headers(headers);
  if (token) h.set('authorization', `Bearer ${token}`);
  if (accept) h.set('accept', accept);
  return handle(new Request(`https://office.example${path}`, { method, headers: h, body }), env);
}

async function ingest(env, rec, headers) {
  const res = await call(env, '/api/ingest', {
    method: 'POST',
    token: INGEST,
    headers,
    body: JSON.stringify(rec),
  });
  assert.equal(res.status, 202, await res.clone().text());
  return res.json();
}

async function login(env) {
  const res = await call(env, '/api/login', { method: 'POST', token: USER });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^__Host-office=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  return cookie.split(';')[0];
}

test('request survives newer working and done events, and message pruning', async () => {
  const env = testEnv();
  const now = Date.now();
  await ingest(env, { bot: 'Health Bot', group: 'Health', status: 'waiting_user', step: WEEKLY, t: new Date(now - 120000).toISOString() });
  await ingest(env, { bot: 'Health Bot', status: 'working', step: WORKOUT, t: new Date(now - 60000).toISOString() });
  const cookie = await login(env);
  let state = await (await call(env, '/office/api/state', { headers: { cookie } })).json();
  assert.equal(state.bots['health-bot'].status, 'working');
  assert.equal(state.bots['health-bot'].step, WORKOUT);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].detail, WEEKLY);
  assert.equal(state.requests[0].owner, 'Health Bot');
  assert.equal(state.requests[0].legacy, true);
  assert.equal(state.requests[0].needs_explicit_ack, true);
  assert.equal(state.requests[0].activity_moved_on, true);
  assert.equal(state.requests[0].activity_status, 'working');
  assert.equal(state.requests_meta.persistence, 'durable');
  assert.equal(state.requests_meta.private, true);
  assert.match(state.ingestion.contract, /Unread chat is not read/);
  const kept = state.requests[0].id;

  await ingest(env, { bot: 'Health Bot', status: 'done', step: WORKOUT, t: new Date(now - 5000).toISOString() });
  deleteMessagesMatching(env._office.sql, WEEKLY);
  state = await (await call(env, '/api/state', { headers: { cookie } })).json();
  assert.equal(state.bots['health-bot'].status, 'done');
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].id, kept);
  assert.equal(state.requests[0].status, 'open');
  const row = env._office.sql.exec(`SELECT status, resolved_at FROM requests WHERE id = ?`, kept).one();
  assert.equal(row.status, 'open');
  assert.equal(row.resolved_at, null);
});

test('repeated ids dedupe and explicit resolve clears only that id', async () => {
  const env = testEnv();
  await ingest(env, {
    type: 'request', id: 'weekly-review', bot: 'Health Bot', action: 'open', detail: WEEKLY, t: '2026-11-01T15:00:00Z',
    source: { kind: 'routine', name: 'weekly review', ref: 'week-45' },
  });
  await ingest(env, {
    type: 'request', id: 'weekly-review', bot: 'Health Bot', action: 'open', detail: 'weekly review, still open', t: '2026-11-01T16:00:00Z',
    source: { kind: 'routine', name: 'weekly review', ref: 'week-45' },
  });
  await ingest(env, {
    type: 'request', id: 'other-ask', bot: 'Health Bot', action: 'open', detail: 'bring the form', t: '2026-11-09T16:05:00Z',
    source: { kind: 'manual', name: 'note' },
  });
  const cookie = await login(env);
  let state = await (await call(env, '/api/state', { headers: { cookie } })).json();
  assert.equal(state.requests.length, 2);
  const weekly = state.requests.find((row) => row.id === 'weekly-review');
  assert.equal(weekly.detail, 'weekly review, still open');
  assert.equal(weekly.opened_at, '2026-11-01T15:00:00Z');
  assert.equal(weekly.source.kind, 'routine');
  assert.equal(weekly.source.name, 'weekly review');
  assert.equal(weekly.legacy, false);

  const resolved = await call(env, '/api/requests/weekly-review/resolve', { method: 'POST', headers: { cookie }, body: '{}' });
  assert.equal(resolved.status, 200);
  const missing = await call(env, '/api/requests/does-not-exist/resolve', { method: 'POST', headers: { cookie }, body: '{}' });
  assert.equal(missing.status, 404);
  state = await (await call(env, '/api/state', { headers: { cookie } })).json();
  assert.deepEqual(state.requests.map((row) => row.id), ['other-ask']);
});

test('unauthorized read and write are blocked, including spoofed access headers', async () => {
  const env = testEnv();
  assert.equal((await call(env, '/api/state')).status, 401);
  assert.equal((await call(env, '/api/ingest', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await call(env, '/office/app.js')).status, 401);
  const wall = await call(env, '/office/', { accept: 'text/html' });
  assert.equal(wall.status, 401);
  assert.match(wall.headers.get('content-type'), /text\/html/);

  const spoof = await call(env, '/api/state', { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' } });
  assert.equal(spoof.status, 401);

  const userWrite = await call(env, '/api/ingest', { method: 'POST', token: USER, body: JSON.stringify({ bot: 'Health Bot', status: 'working', step: 'nope' }) });
  assert.equal(userWrite.status, 403);
  const ingestRead = await call(env, '/api/state', { token: INGEST });
  assert.equal(ingestRead.status, 401);

  const badService = await call(env, '/api/ingest', {
    method: 'POST',
    headers: { 'CF-Access-Client-Id': SERVICE_ID, 'CF-Access-Client-Secret': 'wrong-secret-value-000' },
    body: JSON.stringify({ bot: 'Health Bot', status: 'idle', step: '' }),
  });
  assert.equal(badService.status, 401);

  const badJwt = await call(env, '/api/state', {
    headers: { 'cf-access-jwt-assertion': 'a.b.c', authorization: `Bearer ${USER}` },
  });
  assert.equal(badJwt.status, 401);

  const now = Math.floor(Date.now() / 1000);
  const jwt = makeJwt({
    email: 'owner@example.com',
    aud: 'office-aud',
    iss: 'https://team.example.cloudflareaccess.com',
    exp: now + 600,
    sub: 'user-1',
  });
  const authed = await call(env, '/api/state', {
    headers: { 'cf-access-jwt-assertion': jwt, 'Cf-Access-Authenticated-User-Email': 'other@evil.test' },
  });
  assert.equal(authed.status, 200);
  const body = await authed.json();
  assert.equal(body.auth.email, 'owner@example.com');
  assert.equal(body.auth.method, 'access');

  const service = await call(env, '/api/ingest', {
    method: 'POST',
    headers: { 'CF-Access-Client-Id': SERVICE_ID, 'CF-Access-Client-Secret': SERVICE_SECRET },
    body: JSON.stringify({ type: 'request', id: 'svc-1', bot: 'Health Bot', detail: 'from service', source: { kind: 'manual', name: 'service' } }),
  });
  assert.equal(service.status, 202);
});

test('login sets a session, logout clears it, and no credential is in the HTML', async () => {
  const env = testEnv();
  const cookie = await login(env);
  const ok = await call(env, '/api/session', { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).method, 'session');

  const out = await call(env, '/api/logout', { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await out.json()).access_logout, '/cdn-cgi/access/logout');
  const stale = cookie;
  assert.equal((await call(env, '/api/state', { headers: { cookie: stale } })).status, 401);

  const page = await call(env, '/office/', { accept: 'text/html' });
  const html = await page.text();
  assert.equal(html.includes(USER), false);
  assert.equal(html.includes(INGEST), false);
  assert.equal(html.includes(SERVICE_SECRET), false);
  assert.equal(html.includes('ntfy.sh/'), false);
  const shell = await call(env, '/office/index.html', { headers: { cookie: await login(env) } });
  const shellHtml = await shell.text();
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(shellHtml.includes(USER), false);
  assert.equal(shellHtml.includes(INGEST), false);
  assert.equal(loginHtml(true).includes(USER), false);
  assert.equal(loginHtml(false).includes('type="password"'), false);

  const root = path.resolve(import.meta.dirname, '../..');
  const files = [
    'office/src/worker.js', 'office/src/auth.js', 'office/src/store.js', 'office/src/do.js',
    'web/app.js', 'web/ui/ui.js', 'web/lib/requests.js', 'web/feed.js',
  ];
  const source = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.equal(source.includes(USER), false);
  assert.equal(source.includes(INGEST), false);
  assert.equal(/gbw-[A-Za-z0-9]{22}/.test(source), false);
});

test('signed-in office shell does not redirect to itself', async () => {
  const env = testEnv();
  // Mirror Workers Assets html_handling "auto-trailing-slash".
  env.ASSETS = {
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === '/office/index.html') return new Response(null, { status: 307, headers: { location: '/office/' } });
      if (pathname === '/office/') return new Response('<!doctype html><p>Office shell</p>', { headers: { 'content-type': 'text/html' } });
      return new Response('not found', { status: 404 });
    },
  };
  const now = Math.floor(Date.now() / 1000);
  const jwt = makeJwt({ aud: ['office-aud'], iss: 'https://team.example.cloudflareaccess.com', exp: now + 600, email: 'o@example.test' });
  const headers = { cookie: `CF_Authorization=${jwt}`, accept: 'text/html' };
  let url = 'https://office.example/';
  let hops = 0;
  let res;
  for (; hops < 5; hops++) {
    res = await handle(new Request(url, { headers }), env);
    if (res.status < 300 || res.status >= 400) break;
    url = new URL(res.headers.get('location'), url).href;
  }
  assert.equal(res.status, 200);
  assert.ok(hops <= 1, `took ${hops} redirects`);
  assert.equal(new URL(url).pathname, '/office/');
});

