import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRequestMessage, decorateRequests, legacyRequestId } from './requests.js';

const WEEKLY = 'weekly review';
const WORKOUT = 'evening workout';

function bookFrom(records) {
  const book = new Map();
  for (const [rec, at] of records) applyRequestMessage(book, rec, at);
  return book;
}

test('a later working or done event does not clear an earlier waiting request', () => {
  const book = bookFrom([
    [{ bot: 'Health Bot', status: 'waiting_user', step: WEEKLY }, '2026-11-09T15:00:00Z'],
    [{ bot: 'Health Bot', status: 'working', step: WORKOUT }, '2026-11-09T18:00:00Z'],
    [{ bot: 'Health Bot', status: 'done', step: WORKOUT }, '2026-11-09T19:00:00Z'],
    [{ bot: 'Health Bot', status: 'idle', step: '' }, '2026-11-09T19:05:00Z'],
  ]);
  const open = decorateRequests([...book.values()], {
    'health-bot': { status: 'idle', effective_status: 'idle', step: '' },
  });
  assert.equal(open.length, 1);
  assert.equal(open[0].detail, WEEKLY);
  assert.equal(open[0].owner, 'Health Bot');
  assert.equal(open[0].status, 'open');
  assert.equal(open[0].legacy, true);
  assert.equal(open[0].needs_explicit_ack, true);
  assert.equal(open[0].activity_moved_on, true);
  assert.equal(open[0].activity_status, 'idle');
  assert.equal(book.get(open[0].id).resolved_at, null);
});

test('repeated requests dedupe by id and a different legacy detail stays', () => {
  const book = new Map();
  const first = applyRequestMessage(book, {
    type: 'request', id: 'weekly-review', bot: 'Health Bot', action: 'open', detail: WEEKLY,
    source: { kind: 'routine', name: 'weekly review', at: '2026-11-09T15:00:00Z' },
  }, '2026-11-09T15:00:00Z');
  const again = applyRequestMessage(book, {
    type: 'request', id: 'weekly-review', bot: 'Health Bot', action: 'open', detail: 'weekly review, still open',
    source: { kind: 'routine', name: 'weekly review' },
  }, '2026-11-09T16:00:00Z');
  assert.equal(first.deduped, false);
  assert.equal(again.deduped, true);
  assert.equal(book.size, 1);
  assert.equal(book.get('weekly-review').detail, 'weekly review, still open');
  assert.equal(book.get('weekly-review').opened_at, '2026-11-09T15:00:00Z');
  assert.equal(book.get('weekly-review').source.kind, 'routine');

  applyRequestMessage(book, { bot: 'Health Bot', status: 'waiting_user', step: WEEKLY }, '2026-11-09T15:00:00Z');
  applyRequestMessage(book, { bot: 'Health Bot', status: 'waiting_user', step: WEEKLY }, '2026-11-09T15:05:00Z');
  applyRequestMessage(book, { bot: 'Health Bot', status: 'waiting_user', step: 'different ask' }, '2026-11-09T15:06:00Z');
  const legacy = [...book.values()].filter((row) => row.legacy && row.status === 'open');
  assert.equal(legacy.length, 2);
  assert.equal(legacyRequestId('health-bot', WEEKLY), legacy.find((row) => row.detail === WEEKLY).id);
});

test('explicit resolve clears only the matching id', () => {
  const book = new Map();
  applyRequestMessage(book, { type: 'request', id: 'keep-me', bot: 'Health Bot', detail: WEEKLY, source: { kind: 'manual', name: 'note' } }, '2026-11-09T15:00:00Z');
  applyRequestMessage(book, { type: 'request', id: 'close-me', bot: 'Health Bot', detail: 'other', source: { kind: 'manual', name: 'note' } }, '2026-11-09T15:01:00Z');
  const missed = applyRequestMessage(book, { type: 'request', id: 'missing', action: 'resolve' }, '2026-11-09T15:02:00Z');
  const closed = applyRequestMessage(book, { type: 'request', id: 'close-me', action: 'resolve' }, '2026-11-09T15:03:00Z');
  assert.equal(missed.resolved, false);
  assert.equal(closed.resolved, true);
  const open = decorateRequests([...book.values()], {});
  assert.deepEqual(open.map((row) => row.id), ['keep-me']);
  assert.equal(book.get('keep-me').status, 'open');
  assert.equal(book.get('close-me').status, 'resolved');
});
