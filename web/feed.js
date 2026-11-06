// Bots-only mode: the office reads the user's bots from one feed server. No server of ours, no tunnel.
// The link is …/#<topic>, optionally &ntfy=<https server> and &auth=<ntfy access token>. Both extra
// values live in the fragment, so the site that served this page never receives them. The token is
// sent only on requests to that feed server. The same reducer the local server uses (lib/state.js)
// turns the lines into the office's state. The server keeps 12 hours, so the newest lines are cached
// per topic in localStorage and replayed first: after a quiet night the office is not empty.
//
// Lines on the channel (one JSON object per message, at most 4 KB, anything else is dropped):
//   {"bot":"…","status":"working|idle|waiting_user|error|done","step":"…"}     a status change
//   {"roster":["Bot A","Bot B"]}                                                every bot appears, idle until it posts
//   {"looks":{"Bot A":{"shape":"sphere","color":"#RRGGBB","accessory":"none"}}} how each bot's blob looks
//   {"type":"usage","total_used_pct":37,"resets_at":"…","bots":{"Bot A":4.1}}  the weekly limit meter
//   {"groups":{"Bot A":"Content"}}                                            teams, one floor each
//   {"chat":{"Bot A":"grokbot://app/v1/agent?id=…"}}                         each bot's chat, for «Open chat»
//   {"routines":{"bot":"Bot A","items":[{"name":"…","schedule":"…","next_run":"ISO"}]}}   a bot's routines
//   {"type":"needle","updated_at":"ISO","footer":{"label":"…","url":"https://…"},"items":[…]}  up to 5 decide-later asks
// On top of the server's state the office gets state.finished (done lines of the last 24 h, newest first),
// state.routines (every bot's routines, soonest first), and state.needle (the latest needle strip).
// A needle line never becomes a bot.
import { StateStore, botIdFor, safeChatUrl } from './lib/state.js';
import { parseFeedHash, ntfyAuthUrl, DEFAULT_FEED_SERVER } from './lib/feed-url.js';

const MAX_LINE = 4096, KEEP = 600, TICK_MS = 30e3, DAY_MS = 24 * 3600e3;
const HANDMADE = new Set(['grok-bot', 'jevopus', 'x-writer', 'banner-visuals', 'analytics-analyst', 'competitor-watch', 'qt-scout',
  'ideas-sparring', 'bookmarks-brain', 'codila-x-researcher', 'trendy-x', 'substack', 'x-ads-manager', 'warren-buffett', 'finance-team']);   // assets/blobs/<id>.glb

/** `#<topic>` and the optional `&ntfy=` / `&auth=` fragment params. Null if the link is not a feed. */
export function feedFromHash(hash) {
  return parseFeedHash(hash);
}

/** Rebuild from cache + the server's last 12 h, then follow it live. Calls onState(state) on every change. */
export async function connectFeed({ topic, server, auth }, onState) {
  const base = `${server}/${encodeURIComponent(topic)}`;
  const cacheKey = `bothq.feed.${server}.${topic}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Sofia';
  const store = new StateStore({ tz, hasAvatar: (id) => HANDMADE.has(id) });   // others get a generated blob, no 404 probe
  const cfg = {};                                        // per bot name: { look, chat_url } -> the store's bots config
  const routines = new Map();                            // bot id -> { name, items }
  let latestNeedle = null;                               // last {type:"needle"} record; the next one replaces it
  let lines = [], saveTimer = 0, lastId = null;
  const seen = new Set();

  lines = cached(cacheKey);
  if (!lines.length && server === DEFAULT_FEED_SERVER) {
    // local cache from older builds. Read here only; nothing is fetched from anywhere but `server`.
    lines = cached(`bothq.feed.${DEFAULT_FEED_SERVER}.${topic}`);
    if (!lines.length) lines = cached(`bothq.feed.${topic}`);
  }
  try {
    const text = await (await pull(`${base}/json?poll=1&since=12h`)).text();
    for (const row of text.split('\n')) if (row) keep(JSON.parse(row));
  } catch { /* offline or down: the cache still shows the office */ }
  lines = lines.filter(fresh).sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
  for (const l of lines) ingest(l, true);
  lastId = lines.length ? lines[lines.length - 1].id : null;
  save();
  publish();

  follow();
  setInterval(() => { const v = store.version, s = store.snapshot(); if (store.version !== v) onState(extras(s)); }, TICK_MS);

  function pull(url) {
    return fetch(ntfyAuthUrl(url, auth), { cache: 'no-store', referrerPolicy: 'no-referrer' });
  }
  function cached(key) {
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
  }
  function fresh(l) {
    const a = `${l.id}`, b = `${l.time} ${l.message}`;
    if (seen.has(a) || seen.has(b)) return false;
    seen.add(a);
    seen.add(b);
    return true;
  }
  function keep(m) {                                     // a message of a history request, into `lines`
    if (m?.event === 'message' && typeof m.id === 'string') lines.push({ id: m.id, time: Number(m.time) || 0, message: m.message });
  }
  function take(m) {                                     // a live message: new -> ingest; true if the office changed
    if (m?.event !== 'message' || typeof m.id !== 'string') return false;
    lastId = m.id;
    const l = { id: m.id, time: Number(m.time) || Date.now() / 1000, message: m.message };
    if (!fresh(l)) return false;
    lines.push(l);
    if (lines.length > KEEP * 1.5) lines = lines.slice(-KEEP);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 2000);
    return ingest(l, false);
  }
  function follow() {
    const live = new EventSource(ntfyAuthUrl(`${base}/sse`, auth));
    live.onopen = () => catchUp();                       // also after a reconnect: fetch what was missed
    live.onmessage = (e) => { try { if (take(JSON.parse(e.data))) publish(); } catch { /* keepalive or junk */ } };
  }
  async function catchUp() {
    try {
      const text = await (await pull(`${base}/json?poll=1&since=${lastId ?? '12h'}`)).text();
      let changed = false;
      for (const row of text.split('\n')) if (row && take(JSON.parse(row))) changed = true;
      if (changed) publish();
    } catch { /* the stream retries by itself */ }
  }
  function ingest({ message, time }, replay) {
    if (typeof message !== 'string' || message.length > MAX_LINE) return false;
    let rec;
    try { rec = JSON.parse(message); } catch { return false; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
    // Needle is a filtered backlog strip, not a bot. Handle it before any bot-row ingestion.
    if (rec.type === 'needle') {
      if (!Array.isArray(rec.items)) return false;
      latestNeedle = rec;
      return true;
    }
    const t = typeof rec.t === 'string' ? rec.t : new Date(time * 1000).toISOString();
    if (Array.isArray(rec.roster)) {
      for (const name of rec.roster.slice(0, 400)) {
        if (typeof name === 'string' && name.trim() && !store.bots.has(botIdFor(name))) store.apply({ t, bot: name, status: 'idle', step: '' }, { replay });
      }
      return true;
    }
    if (isMap(rec.looks)) {
      for (const [name, look] of Object.entries(rec.looks).slice(0, 400)) (cfg[name] ||= {}).look = look;
      store.setBotsConfig(cfg);
      return true;
    }
    if (isMap(rec.groups)) {                             // {"groups":{"Bot A":"Content"}}: the main bot's teams = floors
      for (const [name, team] of Object.entries(rec.groups).slice(0, 400)) {
        if (typeof team === 'string' && team.trim()) (cfg[name] ||= {}).floor = team.trim().slice(0, 40);
      }
      store.setBotsConfig(cfg);
      return true;
    }
    if (isMap(rec.chat)) {                               // https pages and grokbot:// app links; scripts are dropped
      for (const [name, url] of Object.entries(rec.chat).slice(0, 400)) {
        const safe = safeChatUrl(url);
        if (safe) (cfg[name] ||= {}).chat_url = safe;
      }
      store.setBotsConfig(cfg);
      return true;
    }
    if (applyRoutineMessage(routines, rec)) return true;
    store.apply({ ...rec, t }, { replay });
    return true;
  }
  function extras(s) {                                   // the panels' data on top of the server-shaped state
    const since = Date.now() - DAY_MS, finished = [];
    for (let i = lines.length - 1; i >= 0 && finished.length < 100; i--) {
      const l = lines[i];
      if (l.time * 1000 < since) break;
      if (typeof l.message !== 'string' || l.message.length > MAX_LINE || !l.message.includes('"done"')) continue;
      let rec;
      try { rec = JSON.parse(l.message); } catch { continue; }
      if (rec?.status !== 'done' || typeof rec.bot !== 'string') continue;
      finished.push({ t: typeof rec.t === 'string' ? rec.t : new Date(l.time * 1000).toISOString(), bot: botIdFor(rec.bot), name: rec.bot.slice(0, 80), step: String(rec.step ?? '').slice(0, 80) });
    }
    s.finished = finished;
    s.routines = routineRows(routines);
    const needle = normalizeNeedle(latestNeedle);
    if (needle) s.needle = needle;
    return s;
  }
  function publish() { store.commit(); onState(extras(store.snapshot())); }
  function save() { try { localStorage.setItem(cacheKey, JSON.stringify(lines.slice(-KEEP))); } catch { /* private mode: not cached */ } }
}

function isMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** The Waiting-panel strip from one needle record. Null unless type is needle and items is an array. */
export function normalizeNeedle(rec) {
  if (!rec || rec.type !== 'needle' || !Array.isArray(rec.items)) return null;
  return {
    items: rec.items.slice(0, 5).filter(it => it && typeof it === 'object' && !Array.isArray(it)).map(it => ({
      ...it,
      detail: needleField(it.detail, 1200),
      question: needleField(it.question, 400),
      source_at: needleField(it.source_at, 80),
      source_url: safeNeedleSourceUrl(it.source_url),
      stale: it.stale === true,
      stale_reason: needleField(it.stale_reason, 400),
    })),
    footer: rec.footer || null,
    updated_at: rec.updated_at || null,
  };
}

export function safeNeedleSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function needleField(v, n) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
}

/** Paste line for Approve / Skip. The office does not call any bot API. */
export function needleCommand(verb, item) {
  if (verb !== 'approve' && verb !== 'skip') return null;
  const id = needleField(item && item.id, 80);
  if (!id) return null;
  const title = needleField(item && item.title, 240);
  return title ? `${verb} needle ${id}: ${title}` : `${verb} needle ${id}`;
}

/** Changes when the next needle post replaces the strip, which clears local Skip hides. */
export function needleSig(needle) {
  if (!needle || typeof needle !== 'object') return '';
  const items = Array.isArray(needle.items) ? needle.items.slice(0, 5) : [];
  const ids = items.map((it) => (it && typeof it === 'object' ? needleField(it.id, 80) : '')).join('|');
  return `${needle.updated_at || ''}|${ids}`;
}

/** One bot's latest list replaces that bot only. Other bots' messages stay. Items may have a schedule and no next_run. */
export function applyRoutineMessage(routines, rec) {
  if (!isMap(rec) || !isMap(rec.routines)) return false;
  const name = typeof rec.routines.bot === 'string' ? rec.routines.bot.trim().slice(0, 80) : '';
  if (!name || !Array.isArray(rec.routines.items)) return false;
  const items = rec.routines.items.slice(0, 50).filter(isMap).map((r) => ({
    routine: String(r.name ?? '').slice(0, 80), schedule: String(r.schedule ?? '').slice(0, 80),
    next_run: Number.isFinite(Date.parse(r.next_run)) ? new Date(r.next_run).toISOString() : null,
  })).filter((r) => r.routine);
  routines.set(botIdFor(name), { name, items });
  return true;
}

export function routineRows(routines) {
  return [...routines].flatMap(([bot, { name, items }]) => items.map((r) => ({ bot, name, ...r })))
    .sort((a, b) => (a.next_run ? Date.parse(a.next_run) : Infinity) - (b.next_run ? Date.parse(b.next_run) : Infinity));
}
