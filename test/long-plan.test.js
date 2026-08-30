// Розклад довгих збірок і відбір роликів. Тут вирішується, що глядач побачить
// у неділю ввечері, тож помилка коштує тижня — перевіряємо ретельно.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kyivWeekday, plannedSize, isCompilationDay, daysBetween, shownOn, candidates,
} from '../src/long-plan.js';

// 2026-08-30 — неділя, 09-01 — вівторок, 09-04 — п'ятниця, 09-02 — середа.
const NEDILYA = new Date('2026-08-30T12:00:00Z');
const VIVTOROK = new Date('2026-09-01T12:00:00Z');
const SEREDA = new Date('2026-09-02T12:00:00Z');
const PYATNYTSYA = new Date('2026-09-04T12:00:00Z');

test('розмір збірки за днем тижня', () => {
  assert.equal(plannedSize(NEDILYA), 5);
  assert.equal(plannedSize(VIVTOROK), 5);
  assert.equal(plannedSize(PYATNYTSYA), 15);
  assert.equal(plannedSize(SEREDA), null);
  assert.equal(isCompilationDay(SEREDA), false);
  assert.equal(isCompilationDay(PYATNYTSYA), true);
});

test('день тижня беремо КИЇВСЬКИЙ, а не UTC', () => {
  // 22:30 UTC суботи — це вже 01:30 неділі в Києві (літній час, UTC+3).
  assert.equal(kyivWeekday(new Date('2026-08-29T22:30:00Z')), 0);
  assert.equal(plannedSize(new Date('2026-08-29T22:30:00Z')), 5);
});

test('різниця в добах', () => {
  assert.equal(daysBetween('2026-08-16', '2026-08-26'), 10);
  assert.equal(daysBetween('2026-08-26', '2026-08-26'), 0);
  assert.equal(daysBetween('', '2026-08-26'), null);
});

test('дату показу беремо з колонки, а без неї — з ID', () => {
  assert.equal(shownOn({ id: 'AUTO-20260816-1221', pubDate: '2026-08-20' }), '2026-08-20');
  assert.equal(shownOn({ id: 'AUTO-20260816-1221', pubDate: '' }), '2026-08-16');
  assert.equal(shownOn({ id: 'OWN-20260825-1313' }), '2026-08-25');
  assert.equal(shownOn({ id: 'дивний-рядок' }), null);
});

// --- Відбір -----------------------------------------------------------------

function rows(n, from = 1) {
  // n рядків із датами 2026-08-01, 02, 03… — найстаріші перші, як у таблиці.
  // Серпень навмисно: липнева партія відсікається за датою (див. DEFAULTS).
  return Array.from({ length: n }, (_, i) => {
    const day = String(from + i).padStart(2, '0');
    return { id: `ID-${day}`, title: `Сюжет ${day}`, pubDate: `2026-08-${day}` };
  });
}

const TODAY = '2026-08-30';

test('рання партія каналу у збірки не йде — відсікаємо за датою', () => {
  const pool = [
    { id: 'РАННІЙ', pubDate: '2026-07-19' },
    { id: 'МЕЖА', pubDate: '2026-07-20' },
    { id: 'ПІЗНІШИЙ', pubDate: '2026-07-25' },
  ];
  const out = candidates(pool, { today: TODAY });
  assert.deepEqual(out.map((r) => r.id), ['МЕЖА', 'ПІЗНІШИЙ'], 'сама межа лишається придатною');
});

test('межу можна зсунути, не чіпаючи код', () => {
  const pool = [{ id: 'СТАРИЙ', pubDate: '2026-06-01' }];
  assert.equal(candidates(pool, { today: TODAY }).length, 0);
  assert.equal(candidates(pool, { today: TODAY, notBefore: '2026-01-01' }).length, 1);
});

test('щойно показане не беремо', () => {
  const fresh = [
    { id: 'СТАРИЙ', pubDate: '2026-08-01' },
    { id: 'ВЧОРАШНІЙ', pubDate: '2026-08-29' },
    { id: 'РІВНО-10-ДНІВ', pubDate: '2026-08-20' },
  ];
  const out = candidates(fresh, { today: TODAY });
  assert.deepEqual(out.map((r) => r.id), ['СТАРИЙ', 'РІВНО-10-ДНІВ']);
});

test('ролик, який недавно був у збірці, відпочиває', () => {
  const pool = [
    { id: 'ДАВНО', pubDate: '2026-08-01' },
    { id: 'ТИЖДЕНЬ-ТОМУ', pubDate: '2026-08-01' },
    { id: 'МІСЯЦЬ-ТОМУ', pubDate: '2026-08-01' },
  ];
  const used = { 'ТИЖДЕНЬ-ТОМУ': '2026-08-23', 'МІСЯЦЬ-ТОМУ': '2026-07-25' };
  const out = candidates(pool, {
    today: TODAY, compiledAt: (id) => used[id] || null,
  });
  assert.deepEqual(out.map((r) => r.id), ['ДАВНО', 'МІСЯЦЬ-ТОМУ']);
});

test('для п\'ятничних 15 карантин повторів вимикається нулем', () => {
  const pool = [{ id: 'А', pubDate: '2026-08-01' }, { id: 'Б', pubDate: '2026-08-01' }];
  const out = candidates(pool, {
    today: TODAY, cooldownDays: 0, compiledAt: () => '2026-08-29',
  });
  assert.deepEqual(out.map((r) => r.id), ['А', 'Б']);
});

test('слабкі ролики зі списку власника не беруться ніколи', () => {
  const out = candidates(rows(15), { today: TODAY, excludeIds: ['ID-12', 'ID-14'] });
  assert.ok(!out.some((r) => r.id === 'ID-12' || r.id === 'ID-14'));
  assert.ok(out.some((r) => r.id === 'ID-13'));
});

test('ролик без жодної дати пропускаємо, а не беремо навмання', () => {
  const out = candidates([{ id: 'БЕЗ-ДАТИ' }, { id: 'ID-01', pubDate: '2026-08-01' }],
    { today: TODAY });
  assert.deepEqual(out.map((r) => r.id), ['ID-01']);
});

// --- Тема --------------------------------------------------------------------
import { buildThemePrompt, parseThemeSet } from '../src/long-plan.js';

const POOL = rows(6).map((r, i) => ({ ...r, title: `Замок ${i + 1}` }));

test('промт несе всі кандидати й потрібну кількість', () => {
  const p = buildThemePrompt(POOL, 5);
  assert.match(p, /рівно з 5 сюжетів/);
  assert.match(p, /ID-01 \| Замок 1/);
  assert.match(p, /ID-06 \| Замок 6/);
});

test('розбирає відповідь моделі', () => {
  const answer = '{"theme":"замки","title":"5 замків України","ids":["ID-02","ID-03","ID-04","ID-05","ID-06"]}';
  const out = parseThemeSet(answer, POOL, 5);
  assert.deepEqual(out.ids, ['ID-02', 'ID-03', 'ID-04', 'ID-05', 'ID-06']);
  assert.equal(out.title, '5 замків України');
  assert.equal(out.toppedUp, false);
});

test('JSON у ```-огорожі теж розбирається', () => {
  const answer = '```json\n{"theme":"т","title":"н","ids":["ID-01","ID-02","ID-03","ID-04","ID-05"]}\n```';
  assert.equal(parseThemeSet(answer, POOL, 5).ids.length, 5);
});

test('вигадані й повторені ID відкидаються, набір добирається', () => {
  const answer = '{"ids":["ID-02","ID-02","НЕМАЄ-ТАКОГО","ID-03"]}';
  const out = parseThemeSet(answer, POOL, 5);
  assert.equal(out.ids.length, 5);
  assert.equal(new Set(out.ids).size, 5);
  assert.ok(out.ids.includes('ID-02') && out.ids.includes('ID-03'));
  assert.ok(!out.ids.includes('НЕМАЄ-ТАКОГО'));
  assert.equal(out.toppedUp, true);
});

test('зовсім крива відповідь не лишає нас без добірки', () => {
  const out = parseThemeSet('вибач, не можу', POOL, 5);
  assert.deepEqual(out.ids, ['ID-01', 'ID-02', 'ID-03', 'ID-04', 'ID-05']);
  assert.equal(out.toppedUp, true);
});

// --- Витіснений шортс --------------------------------------------------------
import { shortDisplacedByLong } from '../src/long-plan.js';

test('о 18:00 у день збірки шортс не йде лише на YouTube', () => {
  assert.equal(shortDisplacedByLong('youtube', 18, NEDILYA), true);
  assert.equal(shortDisplacedByLong('tiktok', 18, NEDILYA), false);
  assert.equal(shortDisplacedByLong('instagram', 18, NEDILYA), false);
});

test('інші години й інші дні не чіпаємо', () => {
  assert.equal(shortDisplacedByLong('youtube', 8, NEDILYA), false);
  assert.equal(shortDisplacedByLong('youtube', 12, PYATNYTSYA), false);
  assert.equal(shortDisplacedByLong('youtube', 18, SEREDA), false);
});

test('година зі слота приходить рядком «18» — теж має спрацювати', () => {
  assert.equal(shortDisplacedByLong('youtube', '18', VIVTOROK), true);
});

// --- Підписи до сюжетів і тижнева добірка ------------------------------------
import { shortLabel } from '../src/long-plan.js';

test('модель дає підпис до кожного сюжету', () => {
  const answer = '{"title":"5 замків","picks":[{"id":"ID-01","label":"Хотинська фортеця"},'
    + '{"id":"ID-02","label":"Замок Паланок"},{"id":"ID-03","label":"Олеський замок"},'
    + '{"id":"ID-04","label":"Луцький замок"},{"id":"ID-05","label":"Кам\'янець"}]}';
  const out = parseThemeSet(answer, POOL, 5);
  assert.equal(out.labels[0], 'Хотинська фортеця');
  assert.equal(out.labels.length, 5);
});

test('без підпису від моделі він виводиться з назви', () => {
  const pool = [{ id: 'X', title: 'Хотинська фортеця: замок, який ти бачив у фільмах' }];
  const out = parseThemeSet('{"ids":["X"]}', pool, 1);
  assert.equal(out.labels[0], 'Хотинська фортеця');
});

test('підпис із назви: до двокрапки, без хвостів', () => {
  assert.equal(shortLabel('Софія Київська: що ховається під стінами'), 'Софія Київська');
  assert.equal(shortLabel('«Кобзар» площею 0,6 мм²: мікромініатюра'), 'Кобзар площею 0,6 мм²');
  assert.equal(shortLabel(''), '');
});

test('тижневий промт просить іншу назву й перелічує вже вжиті', () => {
  const p = buildThemePrompt(POOL, 15, { loose: true, avoidTitles: ['Підземна Україна'] });
  assert.match(p, /тижнева добірка найкращого/);
  assert.match(p, /ЦІ НАЗВИ ВЖЕ БУЛИ/);
  assert.match(p, /Підземна Україна/);
});

test('звичайний промт лишається тематичним', () => {
  const p = buildThemePrompt(POOL, 5);
  assert.match(p, /ГОЛОВНЕ ПРАВИЛО/);
  assert.doesNotMatch(p, /ЦІ НАЗВИ ВЖЕ БУЛИ/);
});

// --- Епізод без готового відео ------------------------------------------------
// Найдорожча помилка добірки: набір складено з рядків таблиці, а монтаж бере
// ФАЙЛ. Немає файлу — валиться весь монтаж, і день згорає.

test('епізод без MP4 у папці до відбору не потрапляє', () => {
  // Так це працює в planDay: спершу відсіюємо ті, чийого відео немає, і лише
  // тоді пускаємо в загальний відбір.
  const published = [
    { id: 'Є-ВІДЕО', pubDate: '2026-08-01' },
    { id: 'НЕМА-ВІДЕО', pubDate: '2026-08-01' },
  ];
  const files = new Set(['Є-ВІДЕО.mp4']);
  const withVideo = published.filter((it) => files.has(`${it.id}.mp4`));
  const out = candidates(withVideo, { today: TODAY });
  assert.deepEqual(out.map((r) => r.id), ['Є-ВІДЕО']);
});
