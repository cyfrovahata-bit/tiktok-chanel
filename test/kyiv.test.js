import test from 'node:test';
import assert from 'node:assert/strict';
import { kyivInstant, nextDailyTimes } from '../src/kyiv.js';

test('kyivInstant: літній час — Київ на 3 години попереду UTC', () => {
  assert.equal(kyivInstant('2026-07-28', 14).toISOString(), '2026-07-28T11:00:00.000Z');
});

test('kyivInstant: зимовий час — на 2 години', () => {
  assert.equal(kyivInstant('2026-01-15', 10).toISOString(), '2026-01-15T08:00:00.000Z');
});

test('kyivInstant: доба переведення стрілок не збиває розрахунок', () => {
  // Останню неділю жовтня 2026 стрілки переводять назад о 04:00 за Києвом.
  assert.equal(kyivInstant('2026-10-25', 10).toISOString(), '2026-10-25T08:00:00.000Z');
  assert.equal(kyivInstant('2026-10-24', 10).toISOString(), '2026-10-24T07:00:00.000Z');
});

test('nextDailyTimes: віддає лише майбутні моменти, за зростанням', () => {
  const now = new Date('2026-07-28T08:30:00Z'); // 11:30 за Києвом
  const times = nextDailyTimes([10, 14, 18], 4, now);
  assert.deepEqual(times.map((t) => t.toISOString()), [
    '2026-07-28T11:00:00.000Z', // 14:00
    '2026-07-28T15:00:00.000Z', // 18:00
    '2026-07-29T07:00:00.000Z', // 10:00 наступного дня
    '2026-07-29T11:00:00.000Z', // 14:00 наступного дня
  ]);
});

test('nextDailyTimes: порожній розклад або нульова кількість — порожньо', () => {
  assert.deepEqual(nextDailyTimes([], 3), []);
  assert.deepEqual(nextDailyTimes([10], 0), []);
});
