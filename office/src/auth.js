// User and machine authentication for the private office.
// Cloudflare Access headers are claims, not proof: a JWT is checked against the team JWKS,
// and a service token is checked against the configured secret. Email headers alone are ignored.

const enc = new TextEncoder();

export function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  return match[1];
}

export async function secretEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const aa = new Uint8Array(da);
  const bb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function configured(value, min) {
  return typeof value === 'string' && value.length >= min;
}

export async function authenticateIngest(request, env) {
  const token = bearerToken(request);
  if (token && configured(env.INGEST_TOKEN, 16) && await secretEqual(token, env.INGEST_TOKEN)) {
    if (configured(env.USER_TOKEN, 16) && await secretEqual(token, env.USER_TOKEN)) return null;
    return { kind: 'ingest', method: 'bearer' };
  }
  const id = request.headers.get('cf-access-client-id');
  const secret = request.headers.get('cf-access-client-secret');
  if (!id || !secret) return null;
  if (!configured(env.ACCESS_SERVICE_CLIENT_ID, 8) || !configured(env.ACCESS_SERVICE_CLIENT_SECRET, 16)) return null;
  const idOk = await secretEqual(id, env.ACCESS_SERVICE_CLIENT_ID);
  const secretOk = await secretEqual(secret, env.ACCESS_SERVICE_CLIENT_SECRET);
  if (!idOk || !secretOk) return null;
  return { kind: 'ingest', method: 'access-service' };
}

function b64urlToBytes(value) {
  const pad = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = pad + '='.repeat((4 - (pad.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function verifyAccessJwt(token, { jwks, aud, issuer, now = Date.now() }) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h64, p64, s64] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p64)));
  } catch {
    return null;
  }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  const keys = jwks && Array.isArray(jwks.keys) ? jwks.keys : [];
  const jwk = keys.find((key) => key && key.kid === header.kid && key.kty === 'RSA' && key.n && key.e);
  if (!jwk) return null;
  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    cryptoKey,
    b64urlToBytes(s64),
    enc.encode(`${h64}.${p64}`),
  );
  if (!ok) return null;
  if (issuer && payload.iss !== issuer) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud || !auds.includes(aud)) return null;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= now) return null;
  if (payload.nbf != null && Number(payload.nbf) * 1000 > now) return null;
  const email = typeof payload.email === 'string' ? payload.email.slice(0, 200) : '';
  return { email, sub: typeof payload.sub === 'string' ? payload.sub.slice(0, 200) : '' };
}

let certCache = { at: 0, keys: null, domain: '' };

export async function loadJwks(env, fetchImpl = fetch) {
  if (configured(env.ACCESS_JWKS_JSON, 2)) {
    try { return JSON.parse(env.ACCESS_JWKS_JSON); } catch { return null; }
  }
  const domain = typeof env.ACCESS_TEAM_DOMAIN === 'string' ? env.ACCESS_TEAM_DOMAIN.trim() : '';
  if (!domain || !/^[A-Za-z0-9.-]+$/.test(domain)) return null;
  const now = Date.now();
  if (certCache.keys && certCache.domain === domain && now - certCache.at < 3600e3) return certCache.keys;
  try {
    const res = await fetchImpl(`https://${domain}/cdn-cgi/access/certs`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || !Array.isArray(body.keys)) return null;
    certCache = { at: now, keys: body, domain };
    return body;
  } catch {
    return null;
  }
}

export function cookieValue(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function signSession(payload, secret) {
  const body = bytesToB64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `${body}.${bytesToB64url(sig)}`;
}

export async function readSession(token, secret, now = Date.now()) {
  if (!configured(secret, 16) || typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))); } catch { return null; }
  if (!data || typeof data.exp !== 'number' || data.exp < now) return null;
  if (typeof data.email !== 'string' || !data.email) return null;
  const gen = Number.isInteger(data.gen) ? data.gen : 0;
  return { kind: 'user', email: data.email.slice(0, 200), method: 'session', gen };
}

export async function authenticateUser(request, env, now = Date.now()) {
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (jwt) {
    const jwks = await loadJwks(env);
    const domain = typeof env.ACCESS_TEAM_DOMAIN === 'string' ? env.ACCESS_TEAM_DOMAIN.trim() : '';
    const identity = await verifyAccessJwt(jwt, {
      jwks,
      aud: env.ACCESS_AUD,
      issuer: domain ? `https://${domain}` : '',
      now,
    });
    if (!identity) return null;
    return { kind: 'user', email: identity.email || identity.sub || 'access-user', method: 'access' };
  }
  const token = bearerToken(request);
  if (token && configured(env.USER_TOKEN, 16) && await secretEqual(token, env.USER_TOKEN)) {
    if (configured(env.INGEST_TOKEN, 16) && await secretEqual(token, env.INGEST_TOKEN)) return null;
    return { kind: 'user', email: 'owner', method: 'bearer' };
  }
  const cookie = cookieValue(request.headers.get('cookie'), '__Host-office');
  if (cookie) return readSession(cookie, env.SESSION_SECRET, now);
  return null;
}

export function sessionCookie(value, maxAge) {
  const base = `__Host-office=${value}; HttpOnly; Secure; SameSite=Lax; Path=/`;
  return maxAge > 0 ? `${base}; Max-Age=${maxAge}` : `${base}; Max-Age=0`;
}
