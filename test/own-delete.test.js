import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blacklistOnReject } from '../src/own.js';

test('тему з ротації заносимо до стоп-листа', () => {
  // Її вигадав генератор — і без запису запропонував би знову.
  assert.equal(blacklistOnReject('AUTO-20260903-1442'), true);
});

test('власний сюжет до стоп-листа не потрапляє', () => {
  // Інакше власник, який видалив свій сюжет через забуті фото, отримав би
  // власну ж тему в списку заборонених.
  assert.equal(blacklistOnReject('OWN-20260907-0005'), false);
});

test('порожній ID не ламає перевірку', () => {
  assert.equal(blacklistOnReject(''), true);
  assert.equal(blacklistOnReject(undefined), true);
});

test('на картці нерозбитого сюжету є кнопка видалення', () => {
  // Раніше там була тільки «Скопіювати промт», і прибрати помилково надісланий
  // сюжет можна було лише руками в таблиці.
  const html = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
  const branch = html.slice(html.indexOf('сюжет ще ніхто не розбивав'), html.indexOf('// Тема окремим полем'));
  assert.match(branch, /🗑 Видалити/);
  assert.match(branch, /api\/pending\/reject/);
  assert.match(branch, /askConfirm/, 'підтвердження має йти через безпечний askConfirm');
});
