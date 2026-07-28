import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnPrompt } from '../src/own.js';
import { parseSlideLines, applySlideLines } from '../src/queue-prompt.js';

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

test('сценарій із власного сюжету редагується тим самим кодом, що й звичайний', () => {
  // Те, що ChatGPT запише в колонку G, мінідодаток має вміти читати й правити.
  const filled = buildOwnPrompt({ ...base, story: 'Текст.', photoCount: 0 })
    .slice(buildOwnPrompt({ ...base, story: 'Текст.', photoCount: 0 }).indexOf('ЗАТВЕРДЖЕНИЙ СЦЕНАРІЙ'))
    .replace('1. {рядок 1}\n2. {рядок 2}\n{і так далі до N}', '1. Перший рядок\n2. Другий рядок');
  assert.deepEqual(parseSlideLines(filled), ['Перший рядок', 'Другий рядок']);
  const edited = applySlideLines(filled, ['Новий перший', 'Другий рядок']);
  assert.deepEqual(parseSlideLines(edited), ['Новий перший', 'Другий рядок']);
});
