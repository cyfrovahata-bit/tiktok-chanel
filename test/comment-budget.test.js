// Запобіжники темпу. Ціна помилки тут не «незручно», а обмеження або блокування
// Сторінки — тобто втрата каналу, а не однієї відповіді.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAct, spend, pause, isPaused, isRateLimit, normalize, nextPauseMs, PAUSE_MS,
} from '../src/comment-budget.js';

const LIM = { perHour: 3, perDay: 5 };
const NOW = Date.parse('2026-08-30T07:30:00Z');

test('поки норма не вибрана — діяти можна', () => {
  assert.equal(canAct({}, NOW, LIM), true);
});

test('годинна стеля зупиняє сплеск', () => {
  let b = {};
  for (let i = 0; i < 3; i++) b = spend(b, NOW);
  assert.equal(canAct(b, NOW, LIM), false, 'три дії за годину — досить');
});

test('нова година обнуляє лічильник', () => {
  let b = {};
  for (let i = 0; i < 3; i++) b = spend(b, NOW);
  const nextHour = NOW + 60 * 60 * 1000;
  assert.equal(canAct(b, nextHour, LIM), true);
  assert.equal(normalize(b, nextHour).inHour, 0);
});

test('добова стеля тримає навіть тоді, коли щогодини норма', () => {
  let b = {};
  let at = NOW;
  for (let i = 0; i < 5; i++) { b = spend(b, at); at += 30 * 60 * 1000; }
  assert.equal(normalize(b, at).inDay, 5);
  assert.equal(canAct(b, at, LIM), false, 'за добу вибрано все');
});

test('нова доба обнуляє добовий лічильник', () => {
  let b = {};
  for (let i = 0; i < 5; i++) b = spend(b, NOW);
  const nextDay = NOW + 24 * 60 * 60 * 1000;
  assert.equal(canAct(b, nextDay, LIM), true);
});

test('після скарги Facebook мовчимо годину', () => {
  const b = pause({}, NOW);
  assert.equal(isPaused(b, NOW + 1000), true);
  assert.equal(canAct(b, NOW + 1000, LIM), false);
  assert.equal(isPaused(b, NOW + 61 * 60 * 1000), false);
});

test('скарги на темп упізнаються, звичайні помилки — ні', () => {
  assert.equal(isRateLimit('(#4) Application request limit reached'), true);
  assert.equal(isRateLimit('(#32) Page request limit reached'), true);
  assert.equal(isRateLimit('This action was flagged as spam'), true);
  assert.equal(isRateLimit('temporarily blocked from performing this action'), true);
  // Зниклий коментар — не привід зупиняти всю Сторінку на годину.
  assert.equal(isRateLimit("Object with ID '1' does not exist"), false);
  assert.equal(isRateLimit('Invalid OAuth access token'), false);
});

test('пауза між діями має розкид, а не рівний такт', () => {
  const small = nextPauseMs(() => 0);
  const big = nextPauseMs(() => 1);
  assert.ok(small < PAUSE_MS && big > PAUSE_MS, `${small}…${big}`);
  assert.ok(small > 0);
});

test('зіпсований стан не ламає рахунок', () => {
  const b = normalize({ hour: null, inHour: 'багато', inDay: NaN }, NOW);
  assert.equal(b.inHour, 0);
  assert.equal(b.inDay, 0);
  assert.equal(canAct(b, NOW, LIM), true);
});
