// Промти, які власник копіює кнопкою. Найдорожча помилка тут — незамінений
// шматок шаблону: людина вставить його в ChatGPT і отримає картинку не про те.
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPromptVideo, previewPromptYouTube, hookPrompt, HOOK_WORD_LIMIT } from '../src/long-copy.js';

const SET = {
  title: '5 замків України',
  theme: 'середньовічні укріплення, що збереглися до сьогодні',
  items: [
    { title: 'Хотинська фортеця: замок, який ти бачив у десятках фільмів' },
    { title: 'Замок тамплієрів на Закарпатті, якого не було' },
  ],
};

for (const [name, build] of [['відео', previewPromptVideo], ['YouTube', previewPromptYouTube]]) {
  test(`промт прев'ю (${name}) несе тему й сюжети`, () => {
    const p = build(SET);
    assert.match(p, /5 замків України/);
    assert.match(p, /середньовічні укріплення/);
    assert.match(p, /Хотинська фортеця/);
    assert.match(p, /Замок тамплієрів/);
  });

  test(`промт прев'ю (${name}) вимагає перевірити літери заголовка`, () => {
    // Кирилицю малює генератор, тож перевірка по літерах обов'язкова в обох.
    assert.match(build(SET), /ПРО ЛІТЕРИ/);
    assert.match(build(SET), /перемалюй, не питаючи/);
  });

  test(`у промті прев'ю (${name}) не лишилось порожніх підстановок`, () => {
    const p = build(SET);
    assert.doesNotMatch(p, /undefined|\[object|\$\{/);
  });
}

test('вертикальне прев\'ю просить саме 9:16, а YouTube — 16:9', () => {
  assert.match(previewPromptVideo(SET), /1080×1920/);
  assert.doesNotMatch(previewPromptVideo(SET), /1280×720/);
  assert.match(previewPromptYouTube(SET), /1280×720/);
});

test('промт хука забороняє «у цьому відео» й тримає межу в словах', () => {
  const p = hookPrompt(SET);
  assert.match(p, /«у цьому відео»/);
  assert.match(p, new RegExp(`${HOOK_WORD_LIMIT} слів`));
  assert.match(p, /5 замків України/);
});

test('порожній набір сюжетів не ламає промт', () => {
  const p = previewPromptVideo({ title: 'Тема', theme: 'опис', items: [] });
  assert.doesNotMatch(p, /undefined/);
});

// --- Назва й опис ------------------------------------------------------------
import {
  metaPrompt, parseMeta, youtubeDescription, facebookPost, TITLE_LIMIT, DESCRIPTION_LIMIT,
} from '../src/long-copy.js';

test('промт назви забороняє повторювати обкладинку', () => {
  const p = metaPrompt(SET);
  assert.match(p, /НЕ повторюй слова з обкладинки/);
  assert.match(p, /5 замків України/);
  assert.match(p, new RegExp(`До ${TITLE_LIMIT} символів`));
});

test('розбирає відповідь моделі', () => {
  const out = parseMeta('{"youtubeTitle":"Замок, якого не було","description":"Опис.","facebook":"ФБ"}', SET);
  assert.equal(out.youtubeTitle, 'Замок, якого не було');
  assert.equal(out.facebook, 'ФБ');
  assert.equal(out.generated, true);
});

test('крива відповідь не лишає відео без назви', () => {
  const out = parseMeta('нічого не вийшло', {
    title: '5 замків України',
    items: [{ title: 'Хотинська фортеця: замок із фільмів' }],
  });
  assert.equal(out.generated, false);
  assert.match(out.youtubeTitle, /5 замків України/);
  assert.ok(out.youtubeTitle.length > 0);
});

test('задовга назва ріжеться під межу YouTube', () => {
  const long = 'а'.repeat(200);
  const out = parseMeta(JSON.stringify({ youtubeTitle: long }), SET);
  assert.ok(out.youtubeTitle.length <= TITLE_LIMIT, `вийшло ${out.youtubeTitle.length}`);
});

test('опис збирається з тексту, таймкодів і хештегів', () => {
  const d = youtubeDescription({
    description: 'Два речення про добірку.',
    chapters: ['0:00 Вступ', '0:05 Хотин'],
  });
  assert.match(d, /Два речення про добірку\./);
  assert.match(d, /0:00 Вступ/);
  assert.match(d, /#Україна/);
  assert.match(d, /підписуйся/);
});

test('без таймкодів опис показує список сюжетів', () => {
  const d = youtubeDescription({ description: 'Текст.', items: SET.items });
  assert.match(d, /Що всередині:/);
  assert.match(d, /Хотинська фортеця/);
  assert.doesNotMatch(d, /Таймкоди/);
});

test('надто довгий опис ріжеться по абзацах, а не посеред таймкоду', () => {
  const d = youtubeDescription({
    description: 'я'.repeat(DESCRIPTION_LIMIT - 100),
    chapters: ['0:00 Вступ', '1:00 Другий'],
  });
  assert.ok(d.length <= DESCRIPTION_LIMIT);
  // Або блок таймкодів цілий, або його немає зовсім — половини бути не може.
  assert.ok(!d.includes('⏱') || d.includes('1:00 Другий'));
});

test('текст для Facebook іде зі своїми хештегами й без таймкодів', () => {
  const t = facebookPost({ facebook: 'Коротко.\n\nПитання?' });
  assert.match(t, /Питання\?/);
  assert.match(t, /#Україна #цікавіфакти$/);
  assert.doesNotMatch(t, /історіяУкраїни/);
});

test('вертикальне прев\'ю теж несе заголовок, як і обкладинка YouTube', () => {
  // Раніше застосунок малював напис сам поверх картинки; тепер його малює
  // генератор, і промт мусить назвати точний текст.
  const p = previewPromptVideo(SET);
  assert.match(p, /ЗАГОЛОВОК НА КАРТИНЦІ/);
  assert.match(p, /ЧИ ЗНАВ ТИ ТАКУ УКРАЇНУ\?/);
  assert.match(p, /5 замків України/);
  assert.doesNotMatch(p, /ЖОДНОГО ТЕКСТУ/);
});

// --- Сила вступу -------------------------------------------------------------
import { hookWeakness } from '../src/long-copy.js';

const CASTLES = [
  { id: 'A1', title: 'Хотинська фортеця: замок, який ти бачив у десятках фільмів' },
  { id: 'A2', title: 'Паланок: фортеця, яку здолали не гармати, а виснаження' },
];

test('абстрактний вступ без жодної конкретики визнається слабким', () => {
  const weak = hookWeakness(
    'Замок може зникнути, але його дух залишиться. Історія перетворює руїни на легенди.',
    CASTLES,
  );
  assert.match(weak, /конкретики/);
});

test('вступ, що називає два різні об\'єкти, проходить', () => {
  assert.equal(
    hookWeakness('Паланок здолали не гармати. А Хотинська фортеця стоїть досі.', CASTLES),
    '',
  );
});

test('вступ про ОДИН об\'єкт не проходить — попереду ціла добірка', () => {
  assert.match(
    hookWeakness('Фортеця Паланок вистояла під артилерією, але здалася тиші.', CASTLES),
    /лише 1 об/,
  );
});

test('спільне для набору слово за об\'єкт не рахується', () => {
  // «фортеця» є і в Хотинській, і в Паланку — воно нічого не розрізняє.
  assert.match(hookWeakness('Ці фортеці пережили більше, ніж здається.', CASTLES), /конкретики/);
});

test('промт хука вимагає кількох об\'єктів і називає їх', () => {
  const p = hookPrompt({ ...SET, items: CASTLES });
  assert.match(p, /це ДОБІРКА, а не анонс одного об/);
  assert.match(p, /Хотинська фортеця/);
  assert.match(p, /Паланок/);
});

test('кліше відкидається навіть із конкретикою', () => {
  assert.match(
    hookWeakness('Дізнайся, як Паланок здолали не гармати, а Хотинська стоїть.', CASTLES),
    /кліше/,
  );
  assert.match(hookWeakness('У цьому відео Паланок і Хотинська фортеця.', CASTLES), /кліше/);
});

test('порожній і задовгий вступ не проходять', () => {
  assert.equal(hookWeakness('', CASTLES), 'порожній');
  assert.equal(hookWeakness('Паланок Хотинська '.repeat(40), CASTLES), 'задовгий');
});

test('промт хука на повторі просить назвати більше ніж один об\'єкт', () => {
  assert.doesNotMatch(hookPrompt(SET), /МИНУЛА СПРОБА/);
  assert.match(hookPrompt(SET, { retry: true }), /МИНУЛА СПРОБА/);
});

test('промти прев\'ю вимагають ефектного світла й недомовленості', () => {
  for (const p of [previewPromptVideo(SET), previewPromptYouTube(SET)]) {
    assert.match(p, /золот/i);
    assert.match(p, /НЕДОГОВОРЕНИМ/);
  }
});

test('запитання у вступі відкидається — на нього легко відповісти «ні»', () => {
  assert.match(
    hookWeakness('Чи знаєш ти, що Паланок і Хотинська фортеця пережили штурми?', CASTLES),
    /запитання/,
  );
});

test('порожня обіцянка замість другого факту не проходить', () => {
  assert.match(
    hookWeakness('Паланок і Хотинська фортеця вистояли. Далі ми покажемо ще більше.', CASTLES),
    /кліше/,
  );
  assert.match(
    hookWeakness('Паланок упав без пострілу, Хотинська — ні. Попереду ще більше.', CASTLES),
    /кліше/,
  );
});

test('промт хука вчить на прикладах, а не лише забороняє', () => {
  const p = hookPrompt({ ...SET, items: CASTLES });
  assert.match(p, /✅/);
  assert.match(p, /❌/);
  assert.match(p, /жодного знака питання/);
});
