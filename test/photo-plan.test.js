import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCreated, photoSchedule } from '../src/photo-plan.js';

// 28.07.2026 22:58 за Києвом = 19:58 UTC (літній час, +3).
const NOW = new Date('2026-07-28T19:58:00Z');
const HOURS = [7, 12, 16];
const kyiv = (iso) => new Date(iso).toLocaleString('uk-UA', {
  timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
});

test('кожен рядок отримує СВОЮ годину, а не спільну найближчу', () => {
  const at = photoSchedule([
    { id: 'A', created: '28.07.2026 08:10:00' },
    { id: 'B', created: '28.07.2026 22:10:00' },
    { id: 'C', created: '28.07.2026 22:43:31' },
  ], HOURS, NOW);
  assert.deepEqual([...at.keys()], ['A', 'B', 'C']);
  assert.deepEqual([...at.values()].map(kyiv), ['07:00', '12:00', '16:00']);
});

test('черга йде за колонкою «Створено», а не за порядком у таблиці', () => {
  const at = photoSchedule([
    { id: 'НОВИЙ', created: '28.07.2026 22:43:31' },
    { id: 'СТАРИЙ', created: '27.07.2026 08:00:00' },
  ], HOURS, NOW);
  assert.equal(kyiv(at.get('СТАРИЙ')), '07:00');
  assert.equal(kyiv(at.get('НОВИЙ')), '12:00');
});

test('рядок без дати створення стає в кінець черги', () => {
  const at = photoSchedule([
    { id: 'БЕЗ_ДАТИ', created: '' },
    { id: 'З_ДАТОЮ', created: '28.07.2026 22:43:31' },
  ], HOURS, NOW);
  assert.equal(kyiv(at.get('З_ДАТОЮ')), '07:00');
  assert.equal(kyiv(at.get('БЕЗ_ДАТИ')), '12:00');
});

test('розклад переходить на наступну добу, коли рядків більше, ніж годин', () => {
  const many = Array.from({ length: 4 }, (_, i) => ({ id: `R${i}`, created: `2${i}.07.2026 08:00:00` }));
  const at = photoSchedule(many, HOURS, NOW);
  assert.equal(at.size, 4);
  assert.equal(kyiv(at.get('R3')), '07:00'); // наступного дня
  assert.ok(new Date(at.get('R3')) > new Date(at.get('R2')));
});

test('дата зі створення розбирається, сміття — ні', () => {
  assert.equal(parseCreated('28.07.2026 22:43:31'), Date.parse('2026-07-28T22:43:31Z'));
  assert.equal(parseCreated('28.07.2026'), Date.parse('2026-07-28T00:00:00Z'));
  assert.equal(parseCreated('вчора'), null);
  assert.equal(parseCreated(''), null);
});

test('дата без провідних нулів теж розбирається', () => {
  // Google Sheets віддає введену вручну дату у власному форматі, зазвичай без
  // нулів. Раніше такий рядок ставав null і падав у кінець черги.
  assert.equal(parseCreated('1.8.2026 0:01:00'), Date.parse('2026-08-01T00:01:00Z'));
  assert.equal(parseCreated('1.8.2026'), Date.parse('2026-08-01T00:00:00Z'));
});

test('ISO-запис від Sheets теж приймається', () => {
  assert.equal(parseCreated('2026-08-01 0:01'), Date.parse('2026-08-01T00:01:00Z'));
  assert.equal(parseCreated('2026-08-01T00:01:00'), Date.parse('2026-08-01T00:01:00Z'));
});

test('рядок із такою датою стає ПЕРШИМ, а не останнім', () => {
  const at = photoSchedule([
    { id: 'СТАРИЙ_ФОРМАТ', created: '22.08.2026 08:00:00' },
    { id: 'ПІДНЯТИЙ', created: '1.8.2026 0:01:00' },
  ], HOURS, NOW);
  assert.ok(new Date(at.get('ПІДНЯТИЙ')) < new Date(at.get('СТАРИЙ_ФОРМАТ')));
});
