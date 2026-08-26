// Мітка «епізод уже був у довгій добірці». Вона лише гасить рядок у списку,
// тож головне в ній — не заважати: не падати на епізоді без готового MP4 і
// не чіпати нічого, крім свого ключа.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markCompiled, videoName } from '../src/videos.js';

function fakeFiles(ids) {
  return new Map(ids.map((id, i) => [videoName(id), { id: `file-${i}`, name: videoName(id) }]));
}

test('ставить дату на кожен використаний епізод', async () => {
  const calls = [];
  const marked = await markCompiled(['A', 'B'], {
    when: new Date('2026-08-26T21:15:00Z'),
    listFiles: async () => fakeFiles(['A', 'B']),
    setProperties: async (fileId, patch) => { calls.push([fileId, patch]); },
  });
  assert.deepEqual(marked, ['A', 'B']);
  assert.deepEqual(calls, [
    ['file-0', { compiledAt: '2026-08-26' }],
    ['file-1', { compiledAt: '2026-08-26' }],
  ]);
});

test('епізод без готового MP4 просто пропускається', async () => {
  const calls = [];
  const marked = await markCompiled(['A', 'НЕМАЄ'], {
    listFiles: async () => fakeFiles(['A']),
    setProperties: async (fileId, patch) => { calls.push([fileId, patch]); },
  });
  assert.deepEqual(marked, ['A']);
  assert.equal(calls.length, 1);
});

test('нічого, крім свого ключа, не пише', async () => {
  let patch = null;
  await markCompiled(['A'], {
    listFiles: async () => fakeFiles(['A']),
    setProperties: async (_id, p) => { patch = p; },
  });
  // Мітки публікації живуть у тих самих appProperties — стерти їх збіркою
  // означало б опублікувати ролик удруге.
  assert.deepEqual(Object.keys(patch), ['compiledAt']);
});
