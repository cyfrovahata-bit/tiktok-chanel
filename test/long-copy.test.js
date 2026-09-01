// Промти, які власник копіює кнопкою. Найдорожча помилка тут — незамінений
// шматок шаблону: людина вставить його в ChatGPT і отримає картинку не про те.
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPromptVideo, previewPromptYouTube } from '../src/long-copy.js';

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

test('вертикальне прев\'ю просить ефектного світла й недомовленості', () => {
  const p = previewPromptVideo(SET);
  assert.match(p, /золот/i);
  assert.match(p, /НЕДОГОВОРЕНИМ/);
});

test('обкладинка YouTube просить одного героя, а не колаж', () => {
  const p = previewPromptYouTube(SET);
  assert.match(p, /ОДИН ГЕРОЙ/);
  assert.doesNotMatch(p, /КОЛАЖ/);
  assert.match(p, /золот/i);
  assert.match(p, /третину висоти/);
});

test('обкладинка пояснює справжній розмір числами, а не образами', () => {
  const p = previewPromptYouTube(SET);
  assert.match(p, /168 пікселів/);
  assert.match(p, /1280 пікселів/);
  assert.doesNotMatch(p, /нігт|сірникову коробку/i);
  assert.match(p, /ПЕРЕВІРКА НА СПРАВЖНЬОМУ РОЗМІРІ/);
});

test('обкладинка вимагає причини натиснути, а не просто краси', () => {
  const p = previewPromptYouTube(SET);
  assert.match(p, /ЩО ЗМУШУЄ НАТИСНУТИ/);
  assert.match(p, /листівка, а не обкладинка/);
  // Прийоми названі конкретно — без них модель малює черговий захід сонця.
  for (const trick of [/відчинені двері/, /сходи/, /туман/, /фігурка/]) {
    assert.match(p, trick);
  }
});

test('напис на обкладинці підставляється замість назви', () => {
  const withCaption = previewPromptYouTube({ ...SET, caption: 'кам\'яний слід' });
  assert.match(withCaption, /КАМ'ЯНИЙ СЛІД/);
  // Без напису лишається назва добірки — обкладинка не буває без тексту.
  assert.match(previewPromptYouTube(SET), /5 ЗАМКІВ УКРАЇНИ/);
});


// --- Хвіст вступу ------------------------------------------------------------
// Це єдине місце, де вступ говорить про конкретну добірку, і єдине, де модель
// іще має свободу. Тому перевірок тут більше, ніж тексту.
import { unitePrompt, parseTail, tailWeakness, TAIL_MAX_WORDS } from '../src/long-copy.js';

const FIVE = [
  { title: 'Хотинська фортеця: замок, який ти бачив у десятках фільмів' },
  { title: 'Паланок: фортеця, яку здолали не гармати, а виснаження' },
  { title: 'Софія Київська: що ховається під бароковими стінами' },
];
const CTX = { items: FIVE, title: 'Серед кам\'яних свідків' };

test('промт хвоста показує саму фразу, у яку його вставлять', () => {
  const p = unitePrompt({ title: CTX.title, theme: 'камінь', items: FIVE, size: 5 });
  assert.match(p, /5 історій, …/);
  assert.match(p, /Хотинська фортеця/);
  assert.match(p, new RegExp(`${TAIL_MAX_WORDS} слів`));
});

test('добрий хвіст проходить', () => {
  for (const good of ['вибитих у камені', 'які пережили імперії й реставрації', 'про людей поза часом']) {
    assert.equal(tailWeakness(good, CTX), '', good);
  }
});

test('хвіст про один об\'єкт не проходить — він мусить бути про всі', () => {
  assert.match(tailWeakness('де стоїть Паланок', CTX), /окремий факт/);
  assert.match(tailWeakness('навколо Софії Київської', CTX), /окремий факт/);
});

test('хвіст не повторює назву добірки — вона й так на екрані', () => {
  assert.match(tailWeakness('серед кам\'яних свідків', CTX), /повторює назву/);
});

test('порожні обіцянки й запитання у хвості відкидаються', () => {
  assert.match(tailWeakness('які тебе здивують', CTX), /кліше/);
  assert.match(tailWeakness('справді дивовижних місць', CTX), /кліше/);
  assert.match(tailWeakness('яких ти не знав', CTX), /кліше/);
  assert.match(tailWeakness('а що всередині?', CTX), /запитання/);
});

test('надто короткий і надто довгий хвіст не проходять', () => {
  assert.match(tailWeakness('каменю', CTX), /закороткий/);
  assert.match(tailWeakness('слово '.repeat(TAIL_MAX_WORDS + 1), CTX), /задовгий/);
  assert.equal(tailWeakness('', CTX), 'порожній');
});

test('відповідь моделі чиститься від лапок, тире й крапки', () => {
  assert.equal(parseTail('«вибитих у камені».'), 'вибитих у камені');
  assert.equal(parseTail('- вибитих у камені\nще щось'), 'вибитих у камені');
  assert.equal(parseTail('  вибитих у камені  '), 'вибитих у камені');
  assert.equal(parseTail(''), '');
});

// --- Напис на обкладинці -----------------------------------------------------
// Обкладинка з 25 тисячами показів зібрала 0,6% кліків — тобто впиралася саме
// в неї, а не в зміст. Назва добірки на мініатюрі не читається: там треба два
// слова, а не п'ять.
import {
  captionPrompt, parseCaption, captionWeakness, captionFromTitle,
  CAPTION_MAX_WORDS, CAPTION_MAX_CHARS,
} from '../src/long-copy.js';

test('промт напису вимагає писати про всю добірку, а не про один факт', () => {
  const p = captionPrompt({ title: 'Серед кам\'яних свідків', theme: 'камінь', items: FIVE });
  assert.match(p, new RegExp(`${CAPTION_MAX_WORDS} слова`));
  assert.match(p, new RegExp(`${CAPTION_MAX_CHARS} літер`));
  assert.match(p, /напис про ВСЮ добірку/);
  assert.match(p, /✅/);
  assert.match(p, /❌/);
});

test('короткий напис про набір проходить', () => {
  for (const good of ['ІНША УКРАЇНА', 'ПІД ЗЕМЛЕЮ', 'КАМІНЬ І ЧАС']) {
    assert.equal(captionWeakness(good, { items: FIVE }), '', good);
  }
});

test('напис про ОДИН факт не проходить — усередині ціла добірка', () => {
  // Саме ця помилка й трапилась: назву відео («Місто, яке знайшли магнітом»)
  // взяли за тему добірки, і напис пообіцяв би одне місто замість п'ятнадцяти
  // різних фактів.
  assert.match(captionWeakness('ХОТИНСЬКА ФОРТЕЦЯ', { items: FIVE }), /один факт/);
  assert.match(captionWeakness('ПРО ПАЛАНОК', { items: FIVE }), /один факт/);
});

test('довгий напис, число й запитання не проходять', () => {
  assert.match(captionWeakness('Україна, якої ти не знав'), /слів замість/);
  assert.match(captionWeakness('15 ФАКТІВ'), /число/);
  assert.match(captionWeakness('ЧИ ЗНАЛИ ВИ?'), /запитання/);
  assert.match(captionWeakness('НЕЙМОВІРНА КАМ\'ЯНА СПАДЩИНА'), /літер замість/);
  assert.equal(captionWeakness(''), 'порожній');
});

test('відповідь моделі чиститься й піднімається в капс', () => {
  assert.equal(parseCaption('«інша україна».'), 'ІНША УКРАЇНА');
  assert.equal(parseCaption('- під землею\nще щось'), 'ПІД ЗЕМЛЕЮ');
});

test('запасний напис береться зі значущих слів назви', () => {
  assert.equal(captionFromTitle('Серед кам\'яних свідків'), 'КАМ\'ЯНИХ СВІДКІВ');
  // Прийменники й займенники не тягнемо: «УКРАЇНА ЯКОЇ ТИ» виглядає як помилка.
  assert.equal(captionFromTitle('Україна, якої ти не знав'), 'УКРАЇНА');
  assert.equal(captionFromTitle('Підземна Україна'), 'ПІДЗЕМНА УКРАЇНА');
});

test('запасний напис завжди вкладається у власні межі', () => {
  for (const title of [
    'Серед кам\'яних свідків', 'Україна, якої ти не знав', 'Підземна Україна',
    'Неймовірна спадщина українського степу', 'Місто, яке знайшли магнітом',
  ]) {
    const caption = captionFromTitle(title);
    assert.equal(captionWeakness(caption), '', `${title} → ${caption}`);
  }
});

test('без списку фактів промти не лишають порожніх розділів', () => {
  const bare = { title: 'Інша Україна', theme: 'факти про Україну', items: [] };
  for (const p of [previewPromptYouTube(bare), captionPrompt(bare)]) {
    assert.doesNotMatch(p, /ФАКТИ ВСЕРЕДИНІ/);
    assert.doesNotMatch(p, /undefined|\$\{/);
  }
});

// --- Узгодження хвоста вступу ------------------------------------------------
// Перед хвостом стоїть «історій» — родовий відмінок множини. Означення до
// нього мусить бути таким самим. У ефір мало піти «5 історій, повні
// несподіваних змін»: модель поставила називний, і диктор прочитав би це
// вголос. Помилку видно лише в готовому відео, тому ловимо кодом.
test('називний відмінок у хвості не проходить', () => {
  for (const bad of [
    'повні несподіваних змін',
    'забуті й повернуті',
    'сховані від чужих очей',
  ]) {
    assert.match(tailWeakness(bad, { items: FIVE }), /не узгоджено/, bad);
  }
});

test('родовий відмінок і підрядні речення проходять', () => {
  for (const good of [
    'сповнених несподіваних перевтілень',
    'вибитих у камені',
    'забутих і повернутих',
    'які пережили імперії',
    'що починалися зовсім не так',
    'про людей поза часом',
  ]) {
    assert.equal(tailWeakness(good, { items: FIVE }), '', good);
  }
});

test('промт показує пари правильно-неправильно, а не саме правило', () => {
  const p = unitePrompt({ title: 'Тема', theme: 'опис', items: FIVE, size: 5 });
  assert.match(p, /РОДОВИЙ відмінок/);
  assert.match(p, /вибитих у камені/);
  assert.match(p, /вибиті у камені/);
  assert.match(p, /ЯКІ пережили імперії/);
});

test("промт обкладинки тримає напис у центральній смузі", () => {
  // Добірка — вертикальне відео, тож у стрічці на телефоні YouTube показує її
  // карткою 4:5 і ріже 1280-піксельну обкладинку до центральних 576. Промт
  // колись просив «текст ліворуч» — саме та половина слова й зникала.
  const p = previewPromptYouTube(SET);
  assert.match(p, /СТРОГО ПО ЦЕНТРУ/);
  assert.match(p, /БЕЗПЕЧНА СМУГА/);
  assert.match(p, /576/);
  assert.doesNotMatch(p, /Текст ліворуч/);
});
