import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNeedle, needleCommand, needleSig } from './feed.js';
import { StateStore, safeNeedleChatUrl, safeNeedleFooterUrl } from './lib/state.js';

const CHAT = 'grokbot://app/v1/agent?id=ad517198-feba-43cc-9312-68c47d77c90c';
const FOOTER = { label: 'Full list: bot dashboard', url: 'https://yash-bot-dashboard.pages.dev' };

test('needle payload keeps five items and replaces the previous strip', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, title: `t${i}`, need: `n${i}` }));
  const first = normalizeNeedle({
    type: 'needle',
    updated_at: '2026-11-06T17:31:15Z',
    footer: FOOTER,
    items: six,
  });
  assert.equal(first.items.length, 5);
  assert.equal(first.items[0].id, 'i0');
  assert.equal(first.items[4].id, 'i4');
  assert.deepEqual(first.footer, FOOTER);
  assert.equal(first.updated_at, '2026-11-06T17:31:15Z');

  const cleared = normalizeNeedle({ type: 'needle', items: [], updated_at: '2026-11-06T18:00:00Z' });
  assert.deepEqual(cleared, { items: [], footer: null, updated_at: '2026-11-06T18:00:00Z' });

  assert.equal(normalizeNeedle({ type: 'needle' }), null);
  assert.equal(normalizeNeedle({ type: 'needle', items: 'nope' }), null);
  assert.equal(normalizeNeedle({ type: 'usage', items: [] }), null);
  assert.equal(normalizeNeedle({ bot: 'BBB Bot', status: 'waiting_user', items: [{ title: 'Ask' }] }), null);
});

test('a needle record does not synthesize a waiting_user bot', () => {
  const store = new StateStore({ now: () => Date.parse('2026-11-06T17:31:15Z') });
  store.apply({
    type: 'needle',
    bot: 'BBB Bot',
    status: 'waiting_user',
    step: 'should not appear',
    items: [{ id: 'a', bot: 'BBB Bot', title: 'Ask', need: 'Pick one', chat_url: CHAT }],
  });
  store.commit();
  const snap = store.snapshot();
  assert.deepEqual(snap.bots, {});
  assert.equal(snap.summary.total, 0);
  assert.equal(snap.summary.waiting_user, 0);
});

test('approve and skip commands, and skip hides only until the next needle post', () => {
  const item = { id: 'd819ca8817f1', title: 'Bell delivered BBB AEO stock-take' };
  assert.equal(needleCommand('approve', item), 'approve needle d819ca8817f1: Bell delivered BBB AEO stock-take');
  assert.equal(needleCommand('skip', item), 'skip needle d819ca8817f1: Bell delivered BBB AEO stock-take');
  assert.equal(needleCommand('approve', { id: 'abc' }), 'approve needle abc');
  assert.equal(needleCommand('delete', item), null);
  assert.equal(needleCommand('approve', { title: 'no id' }), null);

  const first = { updated_at: '2026-11-06T17:31:15Z', items: [{ id: 'a' }, { id: 'b' }] };
  const again = { updated_at: '2026-11-06T17:31:15Z', items: [{ id: 'a' }, { id: 'b' }, { id: 'dropped' }] };
  const next = { updated_at: '2026-11-06T18:00:00Z', items: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(needleSig(first), needleSig({ updated_at: first.updated_at, items: first.items.slice() }));
  assert.notEqual(needleSig(first), needleSig(again));
  assert.notEqual(needleSig(first), needleSig(next));
  assert.equal(needleSig(null), '');
});

test('needle links allow only the agent chat and the dashboard host', () => {
  assert.equal(safeNeedleChatUrl(CHAT), CHAT);
  assert.equal(safeNeedleChatUrl('https://evil.example/agent?id=1'), null);
  assert.equal(safeNeedleChatUrl('javascript:alert(1)'), null);
  assert.equal(safeNeedleChatUrl('grokbot://app/v1/agent?id=abc&next=https://evil.example'), null);
  assert.equal(safeNeedleChatUrl('grokbot://evil/v1/agent?id=ad517198-feba-43cc-9312-68c47d77c90c'), null);
  assert.equal(safeNeedleFooterUrl(FOOTER.url), 'https://yash-bot-dashboard.pages.dev/');
  assert.equal(safeNeedleFooterUrl('http://yash-bot-dashboard.pages.dev'), null);
  assert.equal(safeNeedleFooterUrl('https://evil.example'), null);
  assert.equal(safeNeedleFooterUrl('https://yash-bot-dashboard.pages.dev.evil.com'), null);
  assert.equal(safeNeedleFooterUrl('https://user:pass@yash-bot-dashboard.pages.dev/'), null);
});

test('needle detail fields are bounded and source links require https', () => {
  const item = normalizeNeedle({ type: 'needle', items: [{
    detail: 'd'.repeat(1300), question: 'q'.repeat(500), source_at: '2026-11-03',
    source_url: 'https://app.notion.com/p/example', stale: true, stale_reason: 'Expired',
  }, { source_url: 'javascript:alert(1)', stale: 'true' }, { source_url: 'http://example.com' }] }).items;
  assert.equal(item[0].detail.length, 1200);
  assert.equal(item[0].question.length, 400);
  assert.equal(item[0].source_at, '2026-11-03');
  assert.equal(item[0].source_url, 'https://app.notion.com/p/example');
  assert.equal(item[0].stale, true);
  assert.equal(item[0].stale_reason, 'Expired');
  assert.equal(item[1].source_url, null);
  assert.equal(item[1].stale, false);
  assert.equal(item[2].source_url, null);
});
