import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureHistory, isHistorical, collectHistoryStep } from '../src/comment-history.js';
import { stateDoc } from '../src/comment-flow.js';

test('history checkpoints survive restart, archive answered threads and finish without repeating', async () => {
  let state = { seen: {}, drafts: {} };
  const calls = [];
  const a = { key: 'fb', history: async o => {
    calls.push(o.after);
    return { count: 5, next: o.after ? null : 'cursor', threads: [{ postId: 'p', id: 'root', text: 'Question', publishedAt: '2026-01-01', thread: [{ id: 'own', text: 'Answer', ours: true }] }] };
  } };
  ensureHistory(state, [a], '2026-10-12T12:00:00Z');
  await collectHistoryStep(state, [a]);
  state = JSON.parse(JSON.stringify(stateDoc(state)));
  await collectHistoryStep(state, [a]);
  await collectHistoryStep(state, [a]);
  assert.deepEqual(calls, [null, 'cursor']);
  assert.equal(state.history.platforms.fb.posts, 10);
  assert.equal(state.threads['fb:p:root'].messages.own.text, 'Answer');
  assert.ok(state.history.completedAt);
  assert.deepEqual(state.seen, {});
});

test('history failure keeps cursor and pauses retries', async () => {
  const state = {}; let calls = 0;
  const a = { key: 'ig', history: async () => { calls++; throw new Error('Meta limit'); } };
  await collectHistoryStep(state, [a], { now: 1000 });
  await collectHistoryStep(state, [a], { now: 2000 });
  assert.equal(calls, 1);
  assert.equal(state.history.platforms.ig.after, null);
  assert.equal(state.history.platforms.ig.done, false);
});

test('only Meta archive is suppressed; new replies to old posts remain eligible', () => {
  const state = { history: { startedAt: '2026-10-12T12:00:00Z', platforms: { fb: {}, ig: {} } } };
  assert.equal(isHistorical(state, 'fb', { publishedAt: '2026-10-11' }), true);
  assert.equal(isHistorical(state, 'ig', { publishedAt: '2026-10-12T12:01:00Z', parentId: 'old' }), false);
  assert.equal(isHistorical(state, 'fb', {}), true);
  assert.equal(isHistorical(state, 'yt', {}), false);
});
