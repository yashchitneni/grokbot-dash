// Durable asks, separate from a bot's latest activity status.
// A working / idle / done line never resolves a request. Legacy waiting_user lines stay open
// until something posts {"type":"request","id":"<id>","action":"resolve"} or the office acknowledges that id.
// Unread chat is not a source: only records passed in here are tracked.

import { hash32 } from './util.js';
import { botIdFor } from './state.js';

const ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const KINDS = new Set(['routine', 'manual', 'status', 'chat_forward', 'legacy_status', 'other']);
const WAITING = new Set(['waiting_user', 'waiting', 'waiting_for_user', 'awaiting_user', 'waiting_input']);

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function statusKey(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function legacyRequestId(ownerId, detail) {
  const norm = clean(detail, 160).toLowerCase().replace(/\s+/g, ' ');
  const a = hash32(`${ownerId}\n${norm}`).toString(16).padStart(8, '0');
  const b = hash32(`${norm}\n${ownerId}`).toString(16).padStart(8, '0');
  const id = `legacy:${ownerId}:${a}${b}`;
  return ID_RE.test(id) ? id : null;
}

export function requestId(raw) {
  const id = clean(raw, 80);
  return ID_RE.test(id) ? id : null;
}

function httpsUrl(raw) {
  const s = clean(raw, 2048);
  if (!s) return null;
  try {
    const url = new URL(s);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function normSource(raw, at) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const kind = clean(src.kind, 40).toLowerCase();
  return {
    kind: KINDS.has(kind) ? kind : 'other',
    name: clean(src.name, 80),
    ref: clean(src.ref, 120),
    at: clean(src.at, 40) || at || null,
    url: httpsUrl(src.url),
    note: clean(src.note, 240),
  };
}

function rowFrom(existing, fields) {
  return {
    id: fields.id,
    owner: fields.owner,
    owner_id: fields.owner_id,
    detail: fields.detail,
    source: fields.source,
    opened_at: existing && existing.status === 'open' ? existing.opened_at : fields.at,
    updated_at: fields.at,
    status: 'open',
    legacy: !!fields.legacy,
    resolved_at: null,
    resolved_by: null,
  };
}

/**
 * Apply one ingest record to a Map of request rows. Does not read activity history.
 * @returns {{applied:boolean, ignored?:boolean, deduped?:boolean, resolved?:boolean, id?:string|null, error?:string}}
 */
export function applyRequestMessage(book, rec, at) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { applied: false, ignored: true };
  const when = clean(at, 40) || new Date().toISOString();
  if (rec.type === 'request') {
    const id = requestId(rec.id);
    if (!id) return { applied: false, error: 'bad_id' };
    const action = clean(rec.action || 'open', 20).toLowerCase();
    if (action === 'resolve' || action === 'ack' || action === 'acknowledge') {
      const row = book.get(id);
      if (!row || row.status !== 'open') return { applied: true, resolved: false, id };
      row.status = 'resolved';
      row.resolved_at = when;
      row.resolved_by = clean(rec.resolved_by, 80) || 'ingest';
      row.updated_at = when;
      return { applied: true, resolved: true, id };
    }
    if (action !== 'open') return { applied: false, error: 'bad_action', id };
    const owner = clean(rec.bot || rec.owner, 80);
    const detail = clean(rec.detail || rec.step, 500);
    if (!owner) return { applied: false, error: 'owner_required', id };
    if (!detail) return { applied: false, error: 'detail_required', id };
    const existing = book.get(id);
    const next = rowFrom(existing, {
      id, owner, owner_id: botIdFor(owner), detail, source: normSource(rec.source, when), at: when, legacy: false,
    });
    const deduped = !!(existing && existing.status === 'open');
    book.set(id, next);
    return { applied: true, deduped, id };
  }
  if (rec.type) return { applied: false, ignored: true };
  if (!WAITING.has(statusKey(rec.status))) return { applied: false, ignored: true };
  const owner = clean(rec.bot, 80);
  if (!owner) return { applied: false, ignored: true };
  const detail = clean(rec.step, 160) || 'waiting for you';
  const ownerId = botIdFor(owner);
  const id = legacyRequestId(ownerId, detail);
  if (!id) return { applied: false, error: 'bad_id' };
  const existing = book.get(id);
  const next = rowFrom(existing, {
    id,
    owner,
    owner_id: ownerId,
    detail,
    at: when,
    legacy: true,
    source: {
      kind: 'legacy_status',
      name: 'waiting_user',
      ref: '',
      at: when,
      url: null,
      note: 'Legacy waiting_user line. A later working, idle, or done event does not resolve it.',
    },
  });
  const deduped = !!(existing && existing.status === 'open');
  book.set(id, next);
  return { applied: true, deduped, id, legacy: true };
}

/** Open rows joined to current activity. Joining never changes status. */
export function decorateRequests(rows, bots) {
  const list = Array.isArray(rows) ? rows : [...(rows?.values?.() || [])];
  const botsById = bots && typeof bots === 'object' ? bots : {};
  return list
    .filter((row) => row && row.status === 'open')
    .map((row) => {
      const bot = botsById[row.owner_id] || null;
      const activity = bot ? (bot.status || 'idle') : null;
      return {
        id: row.id,
        owner: row.owner,
        owner_id: row.owner_id,
        detail: row.detail,
        source: row.source,
        opened_at: row.opened_at,
        updated_at: row.updated_at,
        status: 'open',
        legacy: !!row.legacy,
        needs_explicit_ack: !!row.legacy,
        activity_status: activity,
        activity_step: bot && bot.step ? bot.step : null,
        activity_effective: bot ? (bot.effective_status || bot.status || null) : null,
        activity_moved_on: !!row.legacy && activity !== 'waiting_user',
      };
    })
    .sort((a, b) => String(b.opened_at).localeCompare(String(a.opened_at)) || String(a.id).localeCompare(String(b.id)));
}

export function feedRequestsMeta(rows) {
  const open = Array.isArray(rows) ? rows : [];
  const legacy = open.filter((row) => row.needs_explicit_ack).length;
  return {
    persistence: 'feed_replay',
    private: false,
    open: open.length,
    legacy_needs_ack: legacy,
    note: 'Replayed from the feed this page is reading. This is not the private office, and unread chat is not ingested. A newer working, idle, or done line does not resolve a request. Legacy waiting_user rows stay until an explicit resolve.',
  };
}

export function durableRequestsMeta(rows) {
  const open = Array.isArray(rows) ? rows : [];
  const legacy = open.filter((row) => row.needs_explicit_ack).length;
  return {
    persistence: 'durable',
    private: true,
    open: open.length,
    legacy_needs_ack: legacy,
    note: 'Stored in the private office. Unread chat is not ingested. Only an explicit resolve clears a matching request. Legacy waiting_user rows stay open after the bot moves on until you acknowledge that id.',
  };
}
