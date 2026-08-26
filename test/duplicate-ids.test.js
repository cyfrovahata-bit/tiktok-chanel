import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDuplicateIds } from '../src/monitor.js';

const row = (rowNumber, id, status, extra = {}) => ({ rowNumber, id, status, ...extra });

// Перейменування збираємо в масив замість запису в таблицю.
function spy() {
  const calls = [];
  return { calls, rename: async (rowNumber, newId) => calls.push({ rowNumber, newId }) };
}

test('рядок без відео перейменовується, а власник ролика лишає ID', async () => {
  const s = spy();
  const items = [row(10, 'AUTO-1', 'DONE'), row(11, 'AUTO-1', 'NEW')];
  const { renamed, kept } = await splitDuplicateIds(items, s);
  assert.deepEqual(s.calls, [{ rowNumber: 11, newId: 'AUTO-1-2' }]);
  assert.equal(renamed.length, 1);
  assert.equal(kept.length, 0);
});

test('два PUBLISHED розводяться самі — попередження більше не потрібне', async () => {
  const s = spy();
  const items = [row(30, 'AUTO-2', 'PUBLISHED'), row(31, 'AUTO-2', 'PUBLISHED')];
  const { renamed, kept } = await splitDuplicateIds(items, s);
  assert.deepEqual(s.calls, [{ rowNumber: 31, newId: 'AUTO-2-2' }]);
  assert.equal(kept.length, 0, 'власника турбувати нема про що: обидва вже опубліковані');
  assert.equal(renamed[0].to, 'AUTO-2-2');
});

test('DONE у парі з PUBLISHED досі вимагає рішення власника', async () => {
  const s = spy();
  const items = [row(40, 'AUTO-3', 'PUBLISHED'), row(41, 'AUTO-3', 'DONE')];
  const { renamed, kept } = await splitDuplicateIds(items, s);
  assert.equal(s.calls.length, 0, 'нічого не чіпаємо: за ID може лежати неопублікований ролик');
  assert.equal(renamed.length, 0);
  assert.equal(kept.length, 1);
});

test('суфікс не займає вже наявний ID', async () => {
  const s = spy();
  const items = [row(1, 'A', 'DONE'), row(2, 'A', 'NEW'), row(3, 'A-2', 'PUBLISHED')];
  const { renamed } = await splitDuplicateIds(items, s);
  assert.equal(renamed[0].to, 'A-3');
});

test('унікальні ID не чіпаємо', async () => {
  const s = spy();
  const { renamed, kept } = await splitDuplicateIds([row(1, 'A', 'NEW'), row(2, 'B', 'NEW')], s);
  assert.equal(s.calls.length, 0);
  assert.equal(renamed.length + kept.length, 0);
});
