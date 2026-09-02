import test from 'node:test';
import assert from 'node:assert/strict';
import { expirePending } from '../src/comment-flow.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-02T12:00:00Z');
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();

test('картка молодша за 12 годин лишається в черзі', () => {
  const state = { seen: { 'fb:1': 'pending' }, drafts: { 'fb:1': { at: at(11) } }, tries: { 'fb:1': 1 } };
  const out = expirePending(state, NOW);
  assert.deepEqual(out, { dropped: [], closed: [] });
  assert.equal(state.seen['fb:1'], 'pending');
});

test('через 12 годин коментар повертається у звичайний пошук', () => {
  const state = { seen: { 'fb:1': 'pending' }, drafts: { 'fb:1': { at: at(13) } }, tries: { 'fb:1': 1 } };
  const out = expirePending(state, NOW);
  assert.deepEqual(out.dropped, ['fb:1']);
  // Саме ВІДСУТНІСТЬ рішення робить коментар знову свіжим для збирача.
  assert.equal('fb:1' in state.seen, false);
  assert.equal('fb:1' in state.drafts, false);
});

test('картки без дати — з часів до цього правила — прострочені одразу', () => {
  const state = { seen: { 'fb:1': 'pending' }, drafts: { 'fb:1': { messageId: 7 } }, tries: {} };
  assert.deepEqual(expirePending(state, NOW).dropped, ['fb:1']);
});

test('після третього показу картка закривається, а не ходить по колу', () => {
  const state = { seen: { 'fb:1': 'pending' }, drafts: { 'fb:1': { at: at(20) } }, tries: { 'fb:1': 3 } };
  const out = expirePending(state, NOW);
  assert.deepEqual(out, { dropped: [], closed: ['fb:1'] });
  assert.equal(state.seen['fb:1'], 'skipped', 'закрита картка більше не повертається');
});

test('надіслані й пропущені рішення не чіпаємо', () => {
  const state = {
    seen: { 'fb:1': 'sent', 'fb:2': 'skipped', 'fb:3': 'auto' },
    drafts: {}, tries: {},
  };
  const out = expirePending(state, NOW);
  assert.deepEqual(out, { dropped: [], closed: [] });
  assert.deepEqual(state.seen, { 'fb:1': 'sent', 'fb:2': 'skipped', 'fb:3': 'auto' });
});

test('порожній стан не ламає перевірку', () => {
  assert.deepEqual(expirePending({}, NOW), { dropped: [], closed: [] });
});

test('лічильник показів переживає зняття картки з черги', async () => {
  const { stateDoc } = await import('../src/comment-flow.js');
  const state = { seen: { 'fb:1': 'pending' }, drafts: { 'fb:1': { at: at(13) } }, tries: { 'fb:1': 2 } };
  expirePending(state, NOW);
  // Рішення про коментар зникло навмисно — саме це повертає його в пошук.
  assert.equal('fb:1' in state.seen, false);
  // А пам'ять про два покази має лишитися, інакше третій ніколи не настане.
  assert.equal(stateDoc(state).tries['fb:1'], 2);
});

test('стеля пам\'яті обрізає і рішення, і лічильники', async () => {
  const { stateDoc } = await import('../src/comment-flow.js');
  const seen = {}; const tries = {};
  for (let i = 0; i < 10; i++) { seen[`fb:${i}`] = 'sent'; tries[`fb:${i}`] = 1; }
  const doc = stateDoc({ seen, tries, drafts: {} }, 4);
  assert.equal(Object.keys(doc.seen).length, 4);
  assert.equal(Object.keys(doc.tries).length, 4);
  assert.equal('fb:9' in doc.seen, true, 'лишаються найновіші');
});
