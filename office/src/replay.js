// Rebuild roster, looks, and latest activity from stored messages.
// Request rows are not derived here; the requests table is applied by the caller.

import { StateStore, botIdFor, safeChatUrl } from '../../web/lib/state.js';
import { applyRoutineMessage, normalizeNeedle, routineRows } from '../../web/feed.js';

const DAY_MS = 24 * 3600e3;

function isMap(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function replayMessages(messages, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const store = new StateStore({ now: () => now });
  const cfg = {};
  const routines = new Map();
  let latestNeedle = null;
  const finished = [];
  for (const message of messages) {
    let rec;
    try { rec = JSON.parse(message.body); } catch { continue; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const t = typeof rec.t === 'string' ? rec.t : message.t;
    if (rec.type === 'needle') {
      if (Array.isArray(rec.items)) latestNeedle = rec;
      continue;
    }
    if (rec.type === 'request') continue;
    if (Array.isArray(rec.roster)) {
      for (const name of rec.roster.slice(0, 400)) {
        if (typeof name === 'string' && name.trim() && !store.bots.has(botIdFor(name))) {
          store.apply({ t, bot: name, status: 'idle', step: '' });
        }
      }
      continue;
    }
    if (isMap(rec.looks)) {
      for (const [name, look] of Object.entries(rec.looks).slice(0, 400)) (cfg[name] ||= {}).look = look;
      store.setBotsConfig(cfg);
      continue;
    }
    if (isMap(rec.groups)) {
      for (const [name, team] of Object.entries(rec.groups).slice(0, 400)) {
        if (typeof team === 'string' && team.trim()) (cfg[name] ||= {}).floor = team.trim().slice(0, 40);
      }
      store.setBotsConfig(cfg);
      continue;
    }
    if (isMap(rec.chat)) {
      for (const [name, url] of Object.entries(rec.chat).slice(0, 400)) {
        const safe = safeChatUrl(url);
        if (safe) (cfg[name] ||= {}).chat_url = safe;
      }
      store.setBotsConfig(cfg);
      continue;
    }
    if (applyRoutineMessage(routines, rec)) continue;
    store.apply({ ...rec, t });
    if (rec.status === 'done' && typeof rec.bot === 'string') {
      const ms = Date.parse(t);
      if (!Number.isFinite(ms) || now - ms <= DAY_MS) {
        finished.push({
          t,
          bot: botIdFor(rec.bot),
          name: rec.bot.slice(0, 80),
          step: String(rec.step ?? '').slice(0, 80),
        });
      }
    }
  }
  store.commit();
  const state = store.snapshot();
  state.finished = finished.slice(-100).reverse();
  state.routines = routineRows(routines);
  const needle = normalizeNeedle(latestNeedle);
  if (needle) state.needle = needle;
  return state;
}
