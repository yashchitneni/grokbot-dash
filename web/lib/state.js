// State reducer: journal records -> CONTRACT §4 state. Pure in-memory, clock injectable for tests. Runs in Node (the
// server) and in the browser (the office reading a bots channel on ntfy.sh), so: no Node-only APIs here.
import { slugify, hashColor, cleanStr, makeTime, parseTime } from './util.js';

export const LIMITS = {
  MAX_PER_FLOOR: 20,
  HISTORY: 20,
  FEED: 100,
  STUCK_MS: 30 * 60e3,
  DONE_MS: 60e3,
  IDLE_MS: 3 * 3600e3,
  MAX_BOTS: 400,
};

const STATUSES = ['working', 'idle', 'waiting_user', 'error', 'stuck', 'done'];

const STATUS_MAP = {
  working: 'working', idle: 'idle', waiting_user: 'waiting_user', error: 'error', done: 'done',
  waiting: 'waiting_user', waiting_for_user: 'waiting_user', awaiting_user: 'waiting_user', waiting_input: 'waiting_user',
  failed: 'error', fail: 'error', failure: 'error', errored: 'error',
  finished: 'done', complete: 'done', completed: 'done', success: 'done', succeeded: 'done',
  running: 'working', busy: 'working', active: 'working', in_progress: 'working',
  sleeping: 'idle', paused: 'idle', stopped: 'idle',
};

const BUILTIN_FLOORS = [
  { id: 'coordination', name: 'Coordination', aliases: ['координация'] },
  { id: 'x-content', name: 'X content', aliases: ['x-контент', 'x контент'] },
  { id: 'publishing', name: 'Publishing', aliases: ['публикации'] },
  { id: 'finance', name: 'Finance', aliases: ['финансы'] },
];
const GENERAL = { id: 'general', name: 'Main floor', aliases: ['общий этаж'] };   // English names; groups bots write in Russian still match

// Fixed demo ids that a plain slug would not reproduce.
const SLUG_ALIASES = { 'trendy-x-zakladki-i-mega-okhvat': 'trendy-x' };

// Colors of the demo avatars (CONTRACT §8); everyone else gets a hashed color.
const DEMO_COLORS = {
  'grok-bot': '#FF6A13', jevopus: '#FF3FA4', 'x-writer': '#2F6BFF', 'banner-visuals': '#1DB954',
  'analytics-analyst': '#FF4FA0', 'competitor-watch': '#9C6A3C', 'qt-scout': '#FF9F1C',
  'ideas-sparring': '#F0263A', 'bookmarks-brain': '#14B8A6', 'codila-x-researcher': '#111111',
  'trendy-x': '#FF6A13', substack: '#FF6B00', 'x-ads-manager': '#8B5A2B',
  'warren-buffett': '#E8C9A0', 'finance-team': '#2E9E5B',
};

const hex = (str) => Array.from(new TextEncoder().encode(str), (b) => b.toString(16).padStart(2, '0')).join('');   // = Buffer hex, in any runtime

export function botIdFor(name) {
  const slug = slugify(name);
  if (!slug) return `bot-${slugify(hex(String(name)).slice(0, 12)) || 'x'}`;
  return SLUG_ALIASES[slug] || slug;
}

export function normalizeStatus(raw, hasStep, previous) {
  if (typeof raw === 'string') {
    const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (STATUS_MAP[key]) return STATUS_MAP[key];
  }
  if (hasStep) return 'working';
  return previous || 'idle';
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const HEX6 = /^#?[0-9a-f]{6}$/i;                    // look colours: the leading # is optional (Grok Bot sometimes drops it)

// Generated avatars (docs/AVATARS.md). Closed vocabularies: keep in sync with web/scene/looks.js (a test compares them).
// The Grok Bot app's avatar picker (its 14th avatar is sphere + stem), then three older ids kept for old looks.
export const LOOK_SHAPES = [
  'sphere', 'cloud', 'rounded_square', 'star4', 'clover',
  'bubble', 'flower', 'drop', 'pill', 'triangle',
  'pentagon', 'star6', 'hexagon',
  'rounded_cube', 'cone', 'trio',
];
export const LOOK_ACCESSORIES = ['none', 'glasses', 'stem', 'antenna', 'bow'];

/**
 * bots.json `look`: { shape, color, accessory }. Each field is validated on its own: unknown shape -> null,
 * colour must be #RRGGBB or RRGGBB (else null), unknown accessory -> 'none'. A look with neither a usable shape nor a
 * usable colour carries no information and becomes null (the browser then derives both from the bot id).
 */
export function normLook(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  let shape = null;
  if (typeof v.shape === 'string') {
    const s = v.shape.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (LOOK_SHAPES.includes(s)) shape = s;
  }
  const color = typeof v.color === 'string' && HEX6.test(v.color.trim()) ? `#${v.color.trim().replace('#', '').toUpperCase()}` : null;
  let accessory = 'none';
  if (typeof v.accessory === 'string') {
    const a = v.accessory.trim().toLowerCase();
    if (LOOK_ACCESSORIES.includes(a)) accessory = a;
  }
  if (!shape && !color) return null;
  return { shape, color, accessory };
}
/** Chat links the UI may navigate to: https pages, or a grokbot:// app link. Anything else is dropped. */
export function safeChatUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || /[\u0000-\u001f\u007f\s]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if ((u.protocol === 'https:' || u.protocol === 'grokbot:') && u.hostname) return u.href;
  return null;
}

const NEEDLE_CHAT_ID = /^[A-Za-z0-9-]{1,80}$/;
const NEEDLE_FOOTER_HOSTS = new Set(['yash-bot-dashboard.pages.dev']);

function parseSafeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || /[\u0000-\u001f\u007f\s]/.test(s)) return null;
  try { return new URL(s); } catch { return null; }
}

/** Needle "Open chat": only grokbot://app/v1/agent?id=<id>. Anything else is dropped. */
export function safeNeedleChatUrl(raw) {
  const u = parseSafeUrl(raw);
  if (!u) return null;
  if (u.protocol !== 'grokbot:' || u.hostname !== 'app' || u.pathname !== '/v1/agent') return null;
  if (u.username || u.password || u.port || u.hash) return null;
  const id = u.searchParams.get('id');
  if (!id || !NEEDLE_CHAT_ID.test(id) || u.search !== `?id=${id}`) return null;
  return u.href;
}

/** Needle footer link: https only, and only the bot-dashboard host. */
export function safeNeedleFooterUrl(raw) {
  const u = parseSafeUrl(raw);
  if (!u || u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!NEEDLE_FOOTER_HOSTS.has(u.hostname)) return null;
  return u.href;
}

function normBotsCfg(obj) {
  const map = new Map();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return map;
  for (const [key, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object') continue;
    const e = {};
    if (typeof v.floor === 'string' && v.floor.trim()) e.floor = v.floor.trim();
    const chat = safeChatUrl(v.chat_url);
    if (chat) e.chat_url = chat;
    if (typeof v.avatar === 'string' && /^[\w.-]{1,64}$/.test(v.avatar)) e.avatar = v.avatar;
    if (typeof v.color === 'string' && HEX.test(v.color.trim())) e.color = v.color.trim().toUpperCase();
    const look = normLook(v.look);
    if (look) e.look = look;
    map.set(botIdFor(key), e);
  }
  return map;
}

function normFloorsCfg(obj) {
  const cfg = { floors: [], map: new Map() };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return cfg;
  const structured = Array.isArray(obj.floors) || (obj.bots && typeof obj.bots === 'object' && !Array.isArray(obj.bots));
  const mapping = structured ? obj.bots : obj;
  if (structured && Array.isArray(obj.floors)) {
    for (const f of obj.floors) {
      if (typeof f === 'string' && f.trim()) cfg.floors.push({ id: slugify(f) || 'floor', name: f.trim() });
      else if (f && typeof f === 'object') {
        const name = cleanStr(f.name ?? f.id, 60);
        const id = typeof f.id === 'string' && slugify(f.id) ? slugify(f.id) : slugify(name || '');
        if (name && id) cfg.floors.push({ id, name });
      }
    }
  }
  if (mapping && typeof mapping === 'object') {
    for (const [k, v] of Object.entries(mapping)) {
      if (typeof v === 'string' && v.trim()) cfg.map.set(botIdFor(k), v.trim());
    }
  }
  return cfg;
}

export class StateStore {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] clock (ms)
   * @param {string} [opts.tz] IANA zone for timestamps and "today" (default Europe/Sofia)
   * @param {boolean} [opts.demo] force the demo flag
   * @param {(avatarId: string) => boolean} [opts.hasAvatar] does assets/blobs/<id>.glb exist? Adds bots[id].has_glb so the
   *   browser can skip probing (and 404-ing) for hand-made models that are not there
   */
  constructor(opts = {}) {
    this.now = opts.now || Date.now;
    this.time = makeTime(opts.tz || 'Europe/Sofia');
    this.demoFlag = !!opts.demo;
    this.hasAvatar = typeof opts.hasAvatar === 'function' ? opts.hasAvatar : null;
    this.lastEventDemo = false;
    this.version = opts.version ?? Math.floor(this.now() / 1000); // unique per process start, so a restart never reuses a client's `since`
    this.dirty = false;

    this.bots = new Map();       // id -> bot
    this.floorReg = new Map();   // floor id -> {id, name, baseId, n, seq}
    this.members = new Map();    // floor id -> Map(desk -> bot id)
    this.floorSeq = 0;
    this.feed = [];              // newest first
    this.usage = { period: 'week', total: null, resetsMs: null, updatedMs: null, bots: new Map(), routines: {} };
    this.schedules = new Map();  // bot id -> Map(routine -> entry)
    this.floorsCfg = normFloorsCfg(null);
    this.botsCfg = normBotsCfg(null);
    this.meta = { parse_errors: 0, too_long: 0, lines: 0, events: 0, usage_lines: 0, skipped: 0, stale: 0, started_at: this.time.iso(this.now()) };

    this.cache = null;
  }

  // ---------- configuration ----------

  setFloorsConfig(obj) {
    this.floorsCfg = normFloorsCfg(obj);
    this.reassignAll();
    this.dirty = true;
  }

  setBotsConfig(obj) {
    this.botsCfg = normBotsCfg(obj);
    this.reassignAll();
    this.dirty = true;
  }

  // ---------- ingestion ----------

  /** Apply a batch of parsed journal objects. Call commit() afterwards. */
  applyBatch(records, { replay = false } = {}) {
    for (const rec of records) this.apply(rec, { replay });
  }

  apply(rec, { replay = false } = {}) {
    if (!rec || typeof rec !== 'object') return;
    const type = typeof rec.type === 'string' ? rec.type.toLowerCase() : null;
    if (type === 'usage') return this.applyUsage(rec);
    if (type === 'schedule') return this.applySchedule(rec);
    if (type && type !== 'activity' && type !== 'event') { this.meta.skipped++; return; }
    this.applyActivity(rec, replay);
  }

  applyActivity(rec, replay) {
    const name = cleanStr(rec.bot, 80);
    if (!name) { this.meta.skipped++; return; }
    const id = botIdFor(name);
    let bot = this.bots.get(id);
    if (!bot) {
      if (this.bots.size >= LIMITS.MAX_BOTS) { this.meta.skipped++; return; }
      bot = {
        id, name, group: null, status: 'idle', step: null, task: null,
        sinceMs: null, lastMs: null, assign: null, work: null,
        days: new Map(), history: [], eff: 'idle', sig: '',
      };
      this.bots.set(id, bot);
    }
    const now = this.now();
    let ms = parseTime(rec.t);
    if (ms === null || ms > now + 60e3) ms = now;

    const step = cleanStr(rec.step, 160);
    const status = normalizeStatus(rec.status, !!step, bot.lastMs === null ? null : bot.status);

    if (replay && bot.lastMs !== null) {
      if (ms < bot.lastMs || (ms === bot.lastMs && status === bot.status && step === bot.step)) {
        this.meta.stale++;
        return;
      }
    }

    this.meta.events++;
    const prevStatus = bot.lastMs === null ? null : bot.status;
    this.trackWork(bot, status, ms);
    if (status !== prevStatus || bot.sinceMs === null) bot.sinceMs = ms;
    bot.status = status;
    bot.step = step;
    const task = cleanStr(rec.task, 60);
    bot.task = task ?? (status === 'idle' ? null : bot.task);
    const group = cleanStr(rec.group, 60);
    if (group) bot.group = group;
    bot.lastMs = bot.lastMs === null ? ms : Math.max(bot.lastMs, ms);

    bot.history.unshift({ ms, status, step });
    if (bot.history.length > LIMITS.HISTORY) bot.history.length = LIMITS.HISTORY;
    this.feed.unshift({ ms, id, name: bot.name, status, step });
    if (this.feed.length > LIMITS.FEED) this.feed.length = LIMITS.FEED;

    const bucket = this.dayBucket(bot, this.time.day(ms).key);
    bucket.events++;
    bucket.hourly[this.time.hour(ms)]++;
    if (status === 'done') {
      const key = bot.task || '';
      if (!key || !bucket.doneTasks.has(key)) {
        bucket.tasks_done++;
        if (key) bucket.doneTasks.add(key);
      }
    }

    this.lastEventDemo = rec.demo === true;
    this.assign(bot);
    this.refreshSig(bot, now, this.time.day(now));
    this.dirty = true;
  }

  /** Recompute the derived status and the change signature of one bot. Returns true if the signature moved. */
  refreshSig(bot, now, day) {
    const eff = this.effective(bot, now);
    const sig = `${eff}|${this.workMinutes(bot, now, day)}|${day.key}`;
    bot.eff = eff;
    if (sig === bot.sig) return false;
    bot.sig = sig;
    return true;
  }

  applyUsage(rec) {
    this.meta.usage_lines++;
    const u = this.usage;
    const now = this.now();
    const period = cleanStr(rec.period, 20);
    if (period) u.period = period;
    const total = num(rec.total_used_pct);
    if (total !== null) u.total = total;
    const resets = parseTime(rec.resets_at);
    if (resets !== null) u.resetsMs = resets;
    if (rec.bots && typeof rec.bots === 'object' && !Array.isArray(rec.bots)) {
      const m = new Map();
      for (const [k, v] of Object.entries(rec.bots)) {
        const n = num(v);
        if (n !== null) m.set(botIdFor(k), n);
      }
      u.bots = m;
    }
    if (rec.routines && typeof rec.routines === 'object' && !Array.isArray(rec.routines)) {
      const r = {};
      for (const [k, v] of Object.entries(rec.routines).slice(0, 100)) {
        const n = num(v);
        if (n !== null) r[cleanStr(k, 40) || k] = n;
      }
      u.routines = r;
    }
    let ms = parseTime(rec.t);
    if (ms === null || ms > now + 60e3) ms = now;
    u.updatedMs = ms;
    this.dirty = true;
  }

  applySchedule(rec) {
    const name = cleanStr(rec.bot, 80);
    const routine = cleanStr(rec.routine, 40);
    if (!name || !routine) { this.meta.skipped++; return; }
    const id = botIdFor(name);
    let m = this.schedules.get(id);
    if (!m) { m = new Map(); this.schedules.set(id, m); }
    const entry = { routine, cron: cleanStr(rec.cron, 60), lastRunMs: parseTime(rec.last_run) };
    const old = m.get(routine);
    if (!old || old.cron !== entry.cron || old.lastRunMs !== entry.lastRunMs) {
      m.set(routine, entry);
      this.dirty = true;
    }
  }

  // ---------- work time ----------

  trackWork(bot, status, ms) {
    const w = bot.work;
    if (w) {
      if (status === 'working' && ms - w.last <= LIMITS.STUCK_MS) {
        w.last = Math.max(w.last, ms);
        return;
      }
      this.addWork(bot, w.start, Math.min(Math.max(ms, w.last), w.last + LIMITS.STUCK_MS));
      bot.work = null;
    }
    if (status === 'working') bot.work = { start: ms, last: ms };
  }

  addWork(bot, start, end) {
    let s = start;
    while (end > s) {
      const d = this.time.day(s);
      const e = Math.min(end, d.end);
      this.dayBucket(bot, d.key).work_ms += e - s;
      if (e <= s) break;
      s = e;
    }
  }

  dayBucket(bot, key) {
    let b = bot.days.get(key);
    if (!b) {
      b = { work_ms: 0, events: 0, tasks_done: 0, doneTasks: new Set(), hourly: new Array(24).fill(0) };
      bot.days.set(key, b);
      if (bot.days.size > 4) {
        const oldest = [...bot.days.keys()].sort()[0];
        bot.days.delete(oldest);
      }
    }
    return b;
  }

  workMinutes(bot, now, day) {
    let ms = bot.days.get(day.key)?.work_ms ?? 0;
    if (bot.work) {
      const s = Math.max(bot.work.start, day.start);
      const e = Math.min(now, bot.work.last + LIMITS.STUCK_MS);
      if (e > s) ms += e - s;
    }
    return Math.round(ms / 60000);
  }

  // ---------- derived status ----------

  effective(bot, now) {
    if (bot.lastMs === null) return 'idle';
    const age = now - bot.lastMs;
    if (age > LIMITS.IDLE_MS) return 'idle';
    switch (bot.status) {
      case 'done': return age <= LIMITS.DONE_MS ? 'done' : 'idle';
      case 'working': return age > LIMITS.STUCK_MS ? 'stuck' : 'working';
      default: return bot.status;
    }
  }

  /** Re-evaluate everything that depends on time alone. Bumps `version` if a status/minute/day changed. */
  tick() {
    const now = this.now();
    const day = this.time.day(now);
    for (const bot of this.bots.values()) {
      if (this.refreshSig(bot, now, day)) this.dirty = true;
    }
    return this.commit();
  }

  commit() {
    if (!this.dirty) return false;
    this.dirty = false;
    this.version++;
    this.cache = null;
    return true;
  }

  // ---------- floors & desks ----------

  resolveFloor(raw) {
    const s = cleanStr(raw, 60);
    if (!s) return GENERAL;
    const key = s.toLowerCase();
    for (const f of this.floorsCfg.floors) if (f.id.toLowerCase() === key || f.name.toLowerCase() === key) return f;
    for (const f of BUILTIN_FLOORS) if (f.id === key || f.name.toLowerCase() === key || f.aliases.includes(key)) return f;
    if (key === GENERAL.id || key === GENERAL.name.toLowerCase() || GENERAL.aliases.includes(key)) return GENERAL;
    return { id: slugify(s) || 'general', name: s };
  }

  baseFloorOf(bot) {
    const cfg = this.botsCfg.get(bot.id);
    const raw = cfg?.floor ?? this.floorsCfg.map.get(bot.id) ?? bot.group;
    return this.resolveFloor(raw);
  }

  assign(bot) {
    const base = this.baseFloorOf(bot);
    if (bot.assign && bot.assign.base === base.id) return false;
    if (bot.assign) this.members.get(bot.assign.floor)?.delete(bot.assign.desk);
    if (!this.floorReg.has(base.id)) this.floorReg.set(base.id, { id: base.id, name: base.name, baseId: base.id, n: 1, seq: this.floorSeq++ });
    const baseName = this.floorReg.get(base.id).name;
    for (let n = 1; ; n++) {
      const fid = n === 1 ? base.id : `${base.id}-${n}`;
      let occ = this.members.get(fid);
      if (!occ) { occ = new Map(); this.members.set(fid, occ); }
      if (occ.size >= LIMITS.MAX_PER_FLOOR) continue;
      if (!this.floorReg.has(fid)) {
        this.floorReg.set(fid, { id: fid, name: n === 1 ? baseName : `${baseName} · ${n}`, baseId: base.id, n, seq: this.floorSeq++ });
      }
      let desk = 1;
      while (occ.has(desk)) desk++;
      occ.set(desk, bot.id);
      bot.assign = { base: base.id, floor: fid, desk };
      return true;
    }
  }

  reassignAll() {
    for (const bot of this.bots.values()) this.assign(bot);
  }

  floorRank(f) {
    const base = this.floorReg.get(f.baseId) || f;
    let g;
    let idx;
    const ci = this.floorsCfg.floors.findIndex((x) => x.id === f.baseId);
    if (f.baseId === GENERAL.id) { g = 3; idx = 0; }
    else if (ci >= 0) { g = 0; idx = ci; }
    else {
      const bi = BUILTIN_FLOORS.findIndex((x) => x.id === f.baseId);
      if (bi >= 0) { g = 1; idx = bi; } else { g = 2; idx = base.seq; }
    }
    return [g, idx, f.n];
  }

  // ---------- output ----------

  /** Current full state (CONTRACT §4). Re-evaluates time-based statuses first. */
  snapshot() {
    this.tick();
    const now = this.now();
    if (this.cache && this.cache.nowSec === Math.floor(now / 1000)) return this.cache.state;
    const iso = (ms) => this.time.iso(ms);
    const day = this.time.day(now);

    const zero = () => Object.fromEntries(STATUSES.map((s) => [s, 0]));
    const summary = { ...zero(), total: 0 };

    const u = this.usage;
    let total = u.total;
    if (!(total > 0)) {
      let sum = 0;
      for (const v of u.bots.values()) sum += v;
      total = sum > 0 ? sum : null;
    }

    const floorEntries = [...this.floorReg.values()]
      .filter((f) => this.members.get(f.id)?.size)
      .sort((a, b) => {
        const ra = this.floorRank(a);
        const rb = this.floorRank(b);
        return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
      });

    const floors = [];
    const bots = {};
    floorEntries.forEach((f, i) => {
      const occ = this.members.get(f.id);
      const counts = zero();
      const ids = [...occ.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
      floors.push({ id: f.id, name: f.name, order: i + 1, bots: ids, counts, free_desks: LIMITS.MAX_PER_FLOOR - occ.size });
    });
    const floorById = new Map(floors.map((f) => [f.id, f]));

    const botList = [...this.bots.values()];
    for (const bot of botList) {
      const eff = bot.eff;
      summary[eff]++;
      summary.total++;
      floorById.get(bot.assign.floor).counts[eff]++;
    }
    for (const bot of botList) {
      const cfg = this.botsCfg.get(bot.id) || {};
      const pct = u.bots.get(bot.id);
      const bucket = bot.days.get(day.key);
      const sched = this.schedules.get(bot.id);
      bots[bot.id] = {
        id: bot.id,
        name: bot.name,
        floor: bot.assign.floor,
        desk: bot.assign.desk,
        group: bot.group,
        status: bot.status,
        effective_status: bot.eff,
        step: bot.step,
        task: bot.task,
        since: iso(bot.sinceMs),
        last_event: iso(bot.lastMs),
        usage_pct: pct ?? null,
        usage_share: pct !== undefined && total ? Math.round(Math.min(1, Math.max(0, pct / total)) * 1000) / 1000 : null,
        chat_url: cfg.chat_url ?? null,
        avatar: cfg.avatar ?? bot.id,
        color: cfg.color ?? cfg.look?.color ?? DEMO_COLORS[bot.id] ?? hashColor(bot.id),
        look: cfg.look ?? null,
        ...(this.hasAvatar ? { has_glb: !!this.hasAvatar(cfg.avatar ?? bot.id) } : {}),
        today: {
          working_min: this.workMinutes(bot, now, day),
          events: bucket?.events ?? 0,
          tasks_done: bucket?.tasks_done ?? 0,
          hourly: bucket ? [...bucket.hourly] : new Array(24).fill(0),
        },
        history: bot.history.map((h) => ({ t: iso(h.ms), status: h.status, step: h.step })),
        schedule: sched ? [...sched.values()].map((s) => ({ routine: s.routine, cron: s.cron, last_run: iso(s.lastRunMs) })) : [],
      };
    }

    const routines = Object.keys(u.routines).length ? u.routines : undefined;
    const state = {
      version: this.version,
      now: iso(now),
      demo: this.demoFlag || this.lastEventDemo,
      summary,
      usage: {
        period: u.period,
        total_used_pct: u.total,
        resets_at: iso(u.resetsMs),
        updated_at: iso(u.updatedMs),
        ...(routines ? { routines } : {}),
      },
      floors,
      bots,
      feed: this.feed.map((f) => ({ t: iso(f.ms), bot: f.id, name: f.name, status: f.status, step: f.step })),
      meta: { ...this.meta },
    };
    this.cache = { nowSec: Math.floor(now / 1000), state };
    return state;
  }
}

function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
