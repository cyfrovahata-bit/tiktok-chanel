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

test('вступ із назвою об\'єкта з набору проходить', () => {
  assert.equal(
    hookWeakness('Паланок здолали не гармати, а виснаження. Далі буде дивніше.', CASTLES),
    '',
  );
});

test('вступ про ПЕРШИЙ факт не проходить — він піде одразу за вступом', () => {
  assert.match(
    hookWeakness('Хотинську фортецю ти бачив у десятках фільмів і не впізнав.', CASTLES),
    /перший факт/,
  );
});

test('промт хука забороняє згадувати перший факт і називає його', () => {
  const p = hookPrompt({ ...SET, items: CASTLES });
  assert.match(p, /перший факт у відео/);
  assert.match(p, /Хотинська фортеця/);
});

test('число в першому реченні теж вважається конкретикою', () => {
  assert.equal(hookWeakness('Одну фортецю здолали не гармати, а 40 днів без води.', CASTLES), '');
});

test('кліше відкидається навіть із конкретикою', () => {
  assert.match(hookWeakness('Дізнайся, як Паланок здолали не гармати.', CASTLES), /кліше/);
  assert.match(hookWeakness('У цьому відео Паланок та інші.', CASTLES), /кліше/);
});

test('порожній і задовгий вступ не проходять', () => {
  assert.equal(hookWeakness('', CASTLES), 'порожній');
  assert.equal(hookWeakness('Паланок '.repeat(40), CASTLES), 'задовгий');
});

test('промт хука на повторі просить назвати об\'єкт своїм ім\'ям', () => {
  assert.doesNotMatch(hookPrompt(SET), /МИНУЛА СПРОБА/);
  assert.match(hookPrompt(SET, { retry: true }), /МИНУЛА СПРОБА/);
});

test('промти прев\'ю вимагають ефектного світла й недомовленості', () => {
  for (const p of [previewPromptVideo(SET), previewPromptYouTube(SET)]) {
    assert.match(p, /золот/i);
    assert.match(p, /НЕДОГОВОРЕНИМ/);
  }
});
