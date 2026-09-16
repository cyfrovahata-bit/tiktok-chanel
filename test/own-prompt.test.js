import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnPrompt } from '../src/own.js';
import { parseSlideLines, parseTheme, applySlideLines } from '../src/queue-prompt.js';

const base = { rowId: 'OWN-1', folderUrl: 'https://drive.google.com/x' };

test('власний сюжет зупиняється на сценарії, а не малює одразу', () => {
  const p = buildOwnPrompt({ ...base, story: 'Текст сюжету.', photoCount: 0 });
  assert.match(p, /Фото НЕ малюй, архів НЕ збирай/);
  assert.match(p, /«Статус» \(E\) — лишається NEW/);
  assert.doesNotMatch(p, /заміни NEW на DONE/);
});

test('фото власника описані для ДРУГОГО промту, у шаблоні сценарію', () => {
  const p = buildOwnPrompt({ ...base, story: 'Текст.', photoCount: 4 });
  assert.match(p, /ФОТО ВЛАСНИКА \(4 шт\.\)/);
  assert.match(p, /Пріоритет у них/);
  // Блок має стояти всередині шаблону G, тобто після заголовка сценарію.
  assert.ok(p.indexOf('ЗАТВЕРДЖЕНИЙ СЦЕНАРІЙ') < p.indexOf('ФОТО ВЛАСНИКА (4 шт.)'));
});

test('без сюжету промт просить придумати тему за фото', () => {
  const p = buildOwnPrompt({ ...base, story: '', photoCount: 5 });
  assert.match(p, /СЮЖЕТУ НЕМАЄ/);
  assert.match(p, /придумай за ними тему та сюжет/);
});

test('порожній шаблон у промті не показується як готові слайди', () => {
  // Поки ChatGPT не відпрацював, у колонці G лежить завдання з шаблоном
  // «1. {рядок 1}». Мінідодаток мусить бачити рядок як «сюжет ще не розбито».
  const p = buildOwnPrompt({ ...base, story: 'Текст сюжету.', photoCount: 0 });
  assert.deepEqual(parseSlideLines(p), []);
  assert.equal(parseTheme(p), '');
});

test('сценарій із власного сюжету редагується тим самим кодом, що й звичайний', () => {
  // Те, що ChatGPT запише в колонку G, мінідодаток має вміти читати й правити.
  const filled = buildOwnPrompt({ ...base, story: 'Текст.', photoCount: 0 })
    .slice(buildOwnPrompt({ ...base, story: 'Текст.', photoCount: 0 }).indexOf('ЗАТВЕРДЖЕНИЙ СЦЕНАРІЙ'))
    .replace('1. {рядок 1}\n2. {рядок 2}\n{і так далі до N}', '1. Перший рядок\n2. Другий рядок');
  assert.deepEqual(parseSlideLines(filled), ['Перший рядок', 'Другий рядок']);
  const edited = applySlideLines(filled, ['Новий перший', 'Другий рядок']);
  assert.deepEqual(parseSlideLines(edited), ['Новий перший', 'Другий рядок']);
});

test('фактчек власного сюжету має бюджет пошуку', () => {
  // Без межі один сюжет з'їдав п'ятигодинний ліміт ChatGPT: модель обходила
  // по 60+ сайтів, перевіряючи кожне слово окремим запитом.
  for (const story of ['Текст сюжету.', '']) {
    const p = buildOwnPrompt({ ...base, story, photoCount: story ? 0 : 3 });
    assert.match(p, /НЕ БІЛЬШЕ П'ЯТИ пошукових запитів/);
    assert.match(p, /не більше\s+двох сторінок на запит/);
    assert.match(p, /лише те, що піде в рядки слайдів/);
  }
});

test('повторне надсилання перевіряє лише виправлене, а не весь текст', () => {
  // Сюжет уже проходив фактчек: решту тверджень тоді підтвердили, і платити
  // за них удруге немає за що. Причина відмови лежить у «Примітці»
  // відхиленого рядка — саме вона й каже, що перевіряти.
  const p = buildOwnPrompt({
    ...base,
    story: 'Текст сюжету.',
    photoCount: 0,
    retryOf: 'OWN-20260916-1518',
    retryNote: 'Рядок 4 не підтверджено: довжина будинку.',
  });
  assert.match(p, /ПОВТОРНЕ НАДСИЛАННЯ/);
  assert.match(p, /рядком OWN-20260916-1518/);
  assert.match(p, /Рядок 4 не підтверджено/);
  assert.match(p, /НЕ БІЛЬШЕ ДВОХ пошукових запитів/);
  assert.match(p, /Решту вже перевірено — наново НЕ перевіряй/);
  // Звичайний бюджет на повтор не діє: інакше в промті було б дві різні межі.
  assert.doesNotMatch(p, /НЕ БІЛЬШЕ П'ЯТИ/);
});

test('без сліду відхиленого рядка промт лишається звичайним', () => {
  const p = buildOwnPrompt({ ...base, story: 'Текст сюжету.', photoCount: 0 });
  assert.doesNotMatch(p, /ПОВТОРНЕ НАДСИЛАННЯ/);
  assert.match(p, /НЕ БІЛЬШЕ П'ЯТИ пошукових запитів/);
});

test('порожня примітка не лишає в промті голих лапок', () => {
  // Причину могли не записати — тоді блок має пояснити ситуацію без
  // порожнього цитатного блоку, який модель прочитає як «тут нічого немає».
  const p = buildOwnPrompt({ ...base, story: 'Текст.', photoCount: 0, retryOf: 'OWN-1' });
  assert.match(p, /ПОВТОРНЕ НАДСИЛАННЯ/);
  assert.doesNotMatch(p, /не підтвердилось:\s*«««\s*»»»/);
});

test('довга примітка обрізається, а не тягне в промт увесь звіт', () => {
  const p = buildOwnPrompt({
    ...base, story: 'Текст.', photoCount: 0, retryOf: 'OWN-1', retryNote: 'я'.repeat(2000),
  });
  const quoted = /не підтвердилось:\n«««\n([\s\S]*?)\n»»»/.exec(p);
  assert.ok(quoted, 'блок із причиною має бути');
  assert.ok(quoted[1].length <= 600, `надто довго: ${quoted[1].length}`);
});
