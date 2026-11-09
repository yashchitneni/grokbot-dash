import { initUI, renderUI } from './ui.js';
import { StateStore } from '../lib/state.js';
import { applyRequestMessage, decorateRequests, durableRequestsMeta } from '../lib/requests.js';

const now = Date.parse('2026-11-09T18:05:00Z');
const store = new StateStore({ now: () => now });
store.apply({ t: '2026-11-09T15:00:00Z', bot: 'Health Bot', group: 'Health', status: 'waiting_user', step: 'weekly review' });
store.apply({ t: '2026-11-09T18:00:00Z', bot: 'Health Bot', group: 'Health', status: 'working', step: 'evening workout' });
store.apply({ t: '2026-11-09T18:04:00Z', bot: 'Desk Bot', group: 'Health', status: 'idle', step: 'quiet' });
store.commit();
const state = store.snapshot();
const book = new Map();
applyRequestMessage(book, { bot: 'Health Bot', status: 'waiting_user', step: 'weekly review' }, '2026-11-09T15:00:00Z');
applyRequestMessage(book, { bot: 'Health Bot', status: 'working', step: 'evening workout' }, '2026-11-09T18:00:00Z');
state.requests = decorateRequests([...book.values()], state.bots);
state.requests_meta = durableRequestsMeta(state.requests);
state.office = 'private';
state.auth = { email: 'owner@example.com', method: 'access' };
state.demo = false;

initUI({
  onSelectBot() {},
  onSelectFloor() {},
  onZoom() {},
  onOpenChat() {},
});
const floor = state.floors[0]?.id || null;
renderUI(state, { currentFloor: floor, selectedBot: null });
document.getElementById('scene').dataset.ready = '1';
