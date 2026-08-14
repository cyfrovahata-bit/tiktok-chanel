// ID власного сюжету містить лише години й хвилини, тож два надсилання в одну
// хвилину давали однаковий рядок. Це не теорія: 14.08 о 11:56 у таблиці справді
// зʼявилися два OWN-20260814-1156. Далі пошук за ID знаходив перший рядок, і
// правки, видалення й імʼя файлу відео летіли не туди.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownRowId, uniqueOwnId } from '../src/own.js';

const noon = new Date('2026-08-14T08:56:00Z'); // 11:56 за Києвом

test('вільна хвилина — ID без суфікса', async () => {
  assert.equal(await uniqueOwnId(noon, []), 'OWN-20260814-1156');
  assert.equal(await uniqueOwnId(noon, ['OWN-20260814-1155']), 'OWN-20260814-1156');
});

test('зайнята хвилина — суфікс -2, потім -3', async () => {
  const first = ownRowId(noon);
  assert.equal(await uniqueOwnId(noon, [first]), 'OWN-20260814-1156-2');
  assert.equal(await uniqueOwnId(noon, [first, `${first}-2`]), 'OWN-20260814-1156-3');
});

test('суфікс не чіпає рядки інших хвилин і типів', async () => {
  const taken = ['AUTO-20260814-1156', 'OWN-20260814-1157', 'OWN-20260813-1156'];
  assert.equal(await uniqueOwnId(noon, taken), 'OWN-20260814-1156');
});
