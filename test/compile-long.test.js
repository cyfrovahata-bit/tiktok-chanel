import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSilenceGaps, pickCtaCut } from '../src/compile-long.js';

const LOG = `
[silencedetect @ 0x1] silence_start: 12.4
[silencedetect @ 0x1] silence_end: 12.9 | silence_duration: 0.5
[silencedetect @ 0x1] silence_start: 41.2
[silencedetect @ 0x1] silence_end: 41.95 | silence_duration: 0.75
[silencedetect @ 0x1] silence_start: 54.8
[silencedetect @ 0x1] silence_end: 55.6 | silence_duration: 0.8
`;

test('розбирає паузи з виводу silencedetect', () => {
  assert.deepEqual(parseSilenceGaps(LOG), [
    { start: 12.4, end: 12.9 },
    { start: 41.2, end: 41.95 },
    { start: 54.8, end: 55.6 },
  ]);
});

test('незакрита пауза без silence_end до списку не потрапляє', () => {
  const gaps = parseSilenceGaps('silence_start: 3.0\nsilence_start: 7.0\nsilence_end: 7.5');
  assert.deepEqual(gaps, [{ start: 7.0, end: 7.5 }]);
});

test('ріже посередині ОСТАННЬОЇ паузи перед закликом', () => {
  const { cut, gap } = pickCtaCut(parseSilenceGaps(LOG), 62);
  assert.equal(cut, (54.8 + 55.6) / 2);
  assert.equal(gap, 0.8);
});

test('хвостову тишу за паузу не вважає', () => {
  // Остання «пауза» впирається в кінець файлу — це тиша після закінчення мови.
  const gaps = [{ start: 41.2, end: 41.95 }, { start: 55.0, end: 56.0 }];
  const { cut } = pickCtaCut(gaps, 56.4);
  assert.equal(cut, (41.2 + 41.95) / 2);
});

test('коли жодної придатної паузи немає — чесно повертає null', () => {
  assert.deepEqual(pickCtaCut([{ start: 10, end: 11 }], 11.5), { cut: null, total: 11.5, gap: null });
  assert.deepEqual(pickCtaCut([], 60), { cut: null, total: 60, gap: null });
});

import { interleave } from '../src/compile-long.js';

test('роздільники стають МІЖ епізодами, не з краю', () => {
  const parts = ['a.mp4', 'b.mp4', 'c.mp4'];
  const seps = ['s1.mp4', 's2.mp4'];
  assert.deepEqual(interleave(parts, seps),
    ['a.mp4', 's1.mp4', 'b.mp4', 's2.mp4', 'c.mp4']);
});

test('на одному епізоді роздільників немає', () => {
  assert.deepEqual(interleave(['a.mp4'], []), ['a.mp4']);
});

test('порядок епізодів зберігається', () => {
  const parts = ['1', '2', '3', '4'];
  const out = interleave(parts, ['x', 'y', 'z']);
  assert.deepEqual(out.filter((p) => parts.includes(p)), parts);
});

import { timecode, buildChapters } from '../src/compile-long.js';

test('таймкод форматується як в описі YouTube', () => {
  assert.equal(timecode(0), '0:00');
  assert.equal(timecode(9), '0:09');
  assert.equal(timecode(83), '1:23');
  assert.equal(timecode(3753), '1:02:33');
});

test('перший розділ завжди з нуля', () => {
  const lines = buildChapters(['А', 'Б'], [50.4, 47.1], 0.55);
  assert.match(lines[0], /^0:00 А$/);
});

test('розділи враховують і тривалості, і роздільники', () => {
  const lines = buildChapters(['А', 'Б', 'В'], [60, 60, 60], 1);
  assert.deepEqual(lines, ['0:00 А', '1:01 Б', '2:02 В']);
});

test('без роздільників зсуву немає', () => {
  assert.deepEqual(buildChapters(['А', 'Б'], [60, 60], 0), ['0:00 А', '1:00 Б']);
});

import { introAss } from '../src/compile-long.js';

test('розділи зсуваються на тривалість вступу', () => {
  const lines = buildChapters(['А', 'Б'], [60, 60], 0, 4);
  assert.deepEqual(lines, ['0:04 А', '1:04 Б']);
});

test('заставка малюється бандленим Oswald і містить обидва рядки', () => {
  const ass = introAss('15 ІСТОРІЙ', 'ПРО УКРАЇНУ', 4.2);
  assert.match(ass, /Style: Big,Oswald,/);
  assert.match(ass, /15 ІСТОРІЙ/);
  assert.match(ass, /ПРО УКРАЇНУ/);
  assert.match(ass, /0:00:04\.20/); // напис висить рівно стільки, скільки заставка
});

import { buildChaptersWithLeads } from '../src/compile-long.js';

test('розділи з оголошеннями починаються з картки «Факт N»', () => {
  // Перед кожним сюжетом — оголошення на 2 с; глядач, який тисне таймкод,
  // має спершу почути «Факт другий», а не впасти в середину історії.
  const lines = buildChaptersWithLeads(['А', 'Б', 'В'], [60, 60, 60], [2, 2, 2]);
  assert.deepEqual(lines, ['0:00 А', '1:02 Б', '2:04 В']);
});

test('оголошення різної довжини враховуються кожне своє', () => {
  const lines = buildChaptersWithLeads(['А', 'Б'], [30, 30], [1.5, 2.5], 4);
  assert.deepEqual(lines, ['0:04 А', '0:35 Б']);
});

test('вступ із питанням угорі малює три рядки', () => {
  const ass = introAss('15 ФАКТІВ', 'ЯКИХ ТИ, МОЖЛИВО, НЕ ЗНАВ', 4.2, 'ЧИ ЗНАВ ТИ ТАКУ УКРАЇНУ?');
  assert.match(ass, /\\pos\(540,780\)\}ЧИ ЗНАВ ТИ ТАКУ УКРАЇНУ\?/);
  assert.match(ass, /\\pos\(540,900\)\}15 ФАКТІВ/);
  assert.match(ass, /\\pos\(540,1040\)\}ЯКИХ ТИ, МОЖЛИВО, НЕ ЗНАВ/);
});

test('без верхнього рядка заставка лишається дворядковою', () => {
  const ass = introAss('15 ФАКТІВ', 'ПРО УКРАЇНУ', 4.2);
  assert.equal(ass.match(/^Dialogue:/gm).length, 2);
});

import { orderEpisodes } from '../src/compile-long.js';

const ROWS = [
  { id: 'A', title: 'найстаріший' },
  { id: 'B', title: 'середній' },
  { id: 'C', title: 'свіжий' },
];

test('порядок беремо з таблиці: свіжий епізод іде ОСТАННІМ', () => {
  // Мінідодаток показує новіші зверху, тож приходять вони саме так.
  const { items } = orderEpisodes(ROWS, ['C', 'B', 'A']);
  assert.deepEqual(items.map((it) => it.id), ['A', 'B', 'C']);
});

test('непозначені рядки в добірку не потрапляють', () => {
  const { items, missing } = orderEpisodes(ROWS, ['C', 'A']);
  assert.deepEqual(items.map((it) => it.id), ['A', 'C']);
  assert.deepEqual(missing, []);
});

test('невідомий ID повертається окремо, а не мовчки зникає', () => {
  const { items, missing } = orderEpisodes(ROWS, ['A', 'ЩОСЬ']);
  assert.deepEqual(items.map((it) => it.id), ['A']);
  assert.deepEqual(missing, ['ЩОСЬ']);
});

test('дубль ID у таблиці не подвоює епізод у добірці', () => {
  // Однакові ID в таблиці трапляються; беремо перший рядок — той самий, що
  // знайшов би пошук за ID, і рівно один раз.
  const withDupe = [...ROWS, { id: 'B', title: 'дубль' }];
  const { items } = orderEpisodes(withDupe, ['B', 'C']);
  assert.deepEqual(items.map((it) => it.title), ['середній', 'свіжий']);
});

// --- Звук оголошення ---------------------------------------------------------
// Звук чути лише в готовій добірці, через годину після монтажу, тож усе, що
// можна перевірити тут, перевіряємо тут: і вибір варіанта, і те, що фільтр
// складається коректно (крива кількість входів amix валить увесь монтаж).
import { announceFilter, stingName, STINGS, DEFAULT_STING } from '../src/compile-long.js';

test('стандартний звук оголошення — дзвіночок із подихом', () => {
  delete process.env.ANNOUNCE_STING;
  assert.equal(DEFAULT_STING, 'chime-air');
  assert.equal(stingName(), 'chime-air');
});

test('ANNOUNCE_STING перемикає варіант, а сміття відкочується на стандартний', () => {
  process.env.ANNOUNCE_STING = 'air';
  assert.equal(stingName(), 'air');
  process.env.ANNOUNCE_STING = 'нема-такого';
  assert.equal(stingName(), DEFAULT_STING);
  delete process.env.ANNOUNCE_STING;
});

test('кожен варіант оголошує рівно стільки входів amix, скільки відкриває', () => {
  for (const name of Object.keys(STINGS)) {
    const { inputs, filter } = announceFilter('/tmp/a.ass', 3.5, 450, name);
    const mix = /amix=inputs=(\d+)/.exec(filter);
    if (!inputs.length) {
      assert.equal(mix, null, `${name}: без звуку amix не потрібен`);
      assert.match(filter, /\[voice\]anull/);
      continue;
    }
    // Голос плюс усі доріжки звуку.
    assert.equal(Number(mix[1]), inputs.length + 1, `${name}: не збігається з входами`);
    // Кожен відкритий вхід має бути використаний: номери йдуть від двійки.
    for (let i = 0; i < inputs.length; i++) {
      assert.match(filter, new RegExp(`\\[${i + 2}:a\\]`), `${name}: вхід ${i + 2} загублено`);
    }
  }
});

test('фільтр оголошення завжди віддає доріжки [v] і [a]', () => {
  const { filter } = announceFilter('/tmp/a.ass', 3.5, 450, 'chime-air');
  assert.match(filter, /\[v\];/);
  assert.match(filter, /\[a\]$/);
});
