// SQLite shape for one private office. The requests table is the source of truth for asks.
// Activity messages can be pruned; open requests stay until an explicit resolve.

import { applyRequestMessage, decorateRequests, durableRequestsMeta } from '../../web/lib/requests.js';
import { replayMessages } from './replay.js';

const KEEP_MESSAGES = 2000;

export function migrate(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    t TEXT NOT NULL,
    body TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    detail TEXT NOT NULL,
    source_json TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    legacy INTEGER NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )`);
}

function loadBook(sql) {
  const book = new Map();
  const rows = sql.exec(`SELECT id, owner, owner_id, detail, source_json, opened_at, updated_at, status, legacy, resolved_at, resolved_by FROM requests`).toArray();
  for (const row of rows) {
    let source = {};
    try { source = JSON.parse(row.source_json); } catch { source = {}; }
    book.set(row.id, {
      id: row.id,
      owner: row.owner,
      owner_id: row.owner_id,
      detail: row.detail,
      source,
      opened_at: row.opened_at,
      updated_at: row.updated_at,
      status: row.status,
      legacy: !!row.legacy,
      resolved_at: row.resolved_at || null,
      resolved_by: row.resolved_by || null,
    });
  }
  return book;
}

function saveRow(sql, row) {
  sql.exec(
    `INSERT INTO requests (id, owner, owner_id, detail, source_json, opened_at, updated_at, status, legacy, resolved_at, resolved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       owner = excluded.owner,
       owner_id = excluded.owner_id,
       detail = excluded.detail,
       source_json = excluded.source_json,
       opened_at = excluded.opened_at,
       updated_at = excluded.updated_at,
       status = excluded.status,
       legacy = excluded.legacy,
       resolved_at = excluded.resolved_at,
       resolved_by = excluded.resolved_by`,
    row.id,
    row.owner,
    row.owner_id,
    row.detail,
    JSON.stringify(row.source || {}),
    row.opened_at,
    row.updated_at,
    row.status,
    row.legacy ? 1 : 0,
    row.resolved_at,
    row.resolved_by,
  );
}

export function sessionGeneration(sql) {
  const row = sql.exec(`SELECT v FROM meta WHERE k = 'session_gen'`).one();
  return row ? Number(row.v) || 0 : 0;
}

export function bumpSession(sql) {
  const next = sessionGeneration(sql) + 1;
  sql.exec(
    `INSERT INTO meta (k, v) VALUES ('session_gen', ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    String(next),
  );
  return next;
}

export function ingestRecord(sql, rec, at) {
  const body = JSON.stringify(rec);
  sql.exec(`INSERT INTO messages (t, body) VALUES (?, ?)`, at, body);
  sql.exec(`DELETE FROM messages WHERE seq NOT IN (SELECT seq FROM messages ORDER BY seq DESC LIMIT ${KEEP_MESSAGES})`);
  const book = loadBook(sql);
  const result = applyRequestMessage(book, rec, at);
  if (result.applied && result.id && book.has(result.id)) saveRow(sql, book.get(result.id));
  return result;
}

export function snapshot(sql, nowMs) {
  const messages = sql.exec(`SELECT t, body FROM messages ORDER BY seq ASC`).toArray();
  const state = replayMessages(messages, nowMs);
  const open = decorateRequests([...loadBook(sql).values()], state.bots);
  state.requests = open;
  state.requests_meta = durableRequestsMeta(open);
  state.office = 'private';
  state.ingestion = {
    endpoint: 'POST /api/ingest',
    authenticated: true,
    accepts: ['activity', 'request', 'roster', 'looks', 'groups', 'chat', 'routines', 'usage', 'needle'],
    not_ingested: ['chat_unread', 'grok_inbox'],
    contract: 'Only JSON posted to the authenticated ingest endpoint is stored. Unread chat is not read. working, idle, and done never resolve a request. Legacy waiting_user lines stay open until an explicit resolve of that id.',
  };
  return state;
}

export function resolveRequest(sql, id, by, at) {
  const book = loadBook(sql);
  const result = applyRequestMessage(book, { type: 'request', id, action: 'resolve', resolved_by: by }, at);
  if (result.resolved && book.has(id)) saveRow(sql, book.get(id));
  return result;
}

/** Test hook: drop activity lines without touching the request table. */
export function deleteMessagesMatching(sql, needle) {
  const rows = sql.exec(`SELECT seq, body FROM messages`).toArray();
  for (const row of rows) {
    if (String(row.body).includes(needle)) sql.exec(`DELETE FROM messages WHERE seq = ?`, row.seq);
  }
}
