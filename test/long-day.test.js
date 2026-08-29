// Порядок кроків дня. Тік ходить щохвилини, тож головне тут — щоб робота не
// зробилася двічі: два монтажі це півгодини марно й дві різні збірки, а дві
// заливки — два відео на каналі.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStep, NOTIFY_AT, BUILD_AT, PUBLISH_AT, planName } from '../src/long-day.js';

const FIVE = { size: 5 };

test('не день збірки — не робимо нічого', () => {
  assert.equal(nextStep(null, { minutes: 600, size: null }), 'none');
  assert.equal(nextStep({ builtAt: '…' }, { minutes: 1200, size: null }), 'none');
});

test('до восьмої ранку чекаємо', () => {
  assert.equal(nextStep(null, { minutes: NOTIFY_AT - 1, ...FIVE }), 'wait');
  assert.equal(nextStep(null, { minutes: NOTIFY_AT, ...FIVE }), 'plan');
});

test('підібране не підбирається вдруге', () => {
  const plan = { plannedAt: '2026-08-30T05:00:00Z' };
  assert.equal(nextStep(plan, { minutes: NOTIFY_AT + 30, ...FIVE }), 'wait');
  assert.equal(nextStep(plan, { minutes: BUILD_AT, ...FIVE }), 'build');
});

test('змонтоване не монтується вдруге', () => {
  const plan = { plannedAt: '…', builtAt: '…' };
  assert.equal(nextStep(plan, { minutes: BUILD_AT + 60, ...FIVE }), 'wait');
  assert.equal(nextStep(plan, { minutes: PUBLISH_AT, ...FIVE }), 'publish');
});

test('опубліковане не публікується вдруге', () => {
  const plan = { plannedAt: '…', builtAt: '…', youtubeId: 'abc' };
  assert.equal(nextStep(plan, { minutes: PUBLISH_AT + 5, ...FIVE }), 'none');
  assert.equal(nextStep(plan, { minutes: 23 * 60, ...FIVE }), 'none');
});

test('скасований день лежить тихо до кінця доби', () => {
  const plan = { cancelled: true, reason: 'немає прев\'ю' };
  assert.equal(nextStep(plan, { minutes: BUILD_AT, ...FIVE }), 'none');
  assert.equal(nextStep(plan, { minutes: PUBLISH_AT, ...FIVE }), 'none');
});

test('пізній перезапуск наздоганяє пропущений крок, а не пропускає його', () => {
  // Контейнер лежав із 15:00 до 17:00 — монтаж має початися одразу, як ожив.
  assert.equal(nextStep({ plannedAt: '…' }, { minutes: 17 * 60, ...FIVE }), 'build');
  // А якщо лежав до 18:30 і встиг змонтуватись — одразу заливка.
  assert.equal(nextStep({ plannedAt: '…', builtAt: '…' }, { minutes: 18 * 60 + 30, ...FIVE }), 'publish');
});

test('файл стану дня названий за датою', () => {
  assert.equal(planName('2026-08-30'), 'long-2026-08-30.json');
});
