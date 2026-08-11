// Обкладинка для сітки профілю: мітка має вказувати на фрагмент із назвою
// об'єкта, а не на службові слова й не на перший кадр, де тексту ще немає.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coverTimestampMs } from '../src/captions.js';

const DUR = [4.2, 4.0, 4.0];

test('мітка потрапляє у фрагмент із якорем', () => {
  const ms = coverTimestampMs(['ЗАПОРОЗЬКА СІЧ НА ХОРТИЦІ — ЦЕ НЕ ЗОВСІМ ПРАВДА.'], DUR);
  // Фрагмент «ЗАПОРОЗЬКА СІЧ» триває 0–1,09 с; середина має бути всередині.
  assert.ok(ms > 300 && ms < 900, `очікували 300–900 мс, отримали ${ms}`);
});

test('мітка не збігається з першим кадром', () => {
  const ms = coverTimestampMs(['СВІТЯЗЬ — НАЙГЛИБШЕ ОЗЕРО УКРАЇНИ, І МІЛІЄ ВОНО ЧЕРЕЗ КОРДОН.'], DUR);
  assert.ok(ms > 0, 'нуль означав би той самий безтекстовий перший кадр');
});

test('порожні дані не ламають публікацію', () => {
  assert.equal(coverTimestampMs([], []), null);
  assert.equal(coverTimestampMs(null, null), null);
  assert.equal(coverTimestampMs(['ЄДИНИЙ РЯДОК ТУТ'], []), null);
});

test('мітка лишається в межах першого слайда', () => {
  const ms = coverTimestampMs(['ОПТИМІСТИЧНА ПЕЧЕРА ДОСІ НЕ МАЄ ЗНАЙДЕНОГО КІНЦЯ.'], DUR);
  assert.ok(ms < DUR[0] * 1000, `мітка ${ms} мс вийшла за перший слайд`);
});
