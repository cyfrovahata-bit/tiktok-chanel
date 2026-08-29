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
  // n рядків із датами 2026-07-01, 02, 03… — найстаріші перші, як у таблиці.
  return Array.from({ length: n }, (_, i) => {
    const day = String(from + i).padStart(2, '0');
    return { id: `ID-${day}`, title: `Сюжет ${day}`, pubDate: `2026-07-${day}` };
  });
}

const TODAY = '2026-08-30';

test('перші десять роликів каналу у збірку не йдуть', () => {
  const out = candidates(rows(15), { today: TODAY });
  assert.deepEqual(out.map((r) => r.id), ['ID-11', 'ID-12', 'ID-13', 'ID-14', 'ID-15']);
});

test('щойно показане не беремо', () => {
  const fresh = [
    { id: 'СТАРИЙ', pubDate: '2026-08-01' },
    { id: 'ВЧОРАШНІЙ', pubDate: '2026-08-29' },
    { id: 'РІВНО-10-ДНІВ', pubDate: '2026-08-20' },
  ];
  const out = candidates(fresh, { today: TODAY, skipFirst: 0 });
  assert.deepEqual(out.map((r) => r.id), ['СТАРИЙ', 'РІВНО-10-ДНІВ']);
});

test('ролик, який недавно був у збірці, відпочиває', () => {
  const pool = [
    { id: 'ДАВНО', pubDate: '2026-07-01' },
    { id: 'ТИЖДЕНЬ-ТОМУ', pubDate: '2026-07-01' },
    { id: 'МІСЯЦЬ-ТОМУ', pubDate: '2026-07-01' },
  ];
  const used = { 'ТИЖДЕНЬ-ТОМУ': '2026-08-23', 'МІСЯЦЬ-ТОМУ': '2026-07-25' };
  const out = candidates(pool, {
    today: TODAY, skipFirst: 0, compiledAt: (id) => used[id] || null,
  });
  assert.deepEqual(out.map((r) => r.id), ['ДАВНО', 'МІСЯЦЬ-ТОМУ']);
});

test('для п\'ятничних 15 карантин повторів вимикається нулем', () => {
  const pool = [{ id: 'А', pubDate: '2026-07-01' }, { id: 'Б', pubDate: '2026-07-01' }];
  const out = candidates(pool, {
    today: TODAY, skipFirst: 0, cooldownDays: 0, compiledAt: () => '2026-08-29',
  });
  assert.deepEqual(out.map((r) => r.id), ['А', 'Б']);
});

test('слабкі ролики зі списку власника не беруться ніколи', () => {
  const out = candidates(rows(15), { today: TODAY, excludeIds: ['ID-12', 'ID-14'] });
  assert.deepEqual(out.map((r) => r.id), ['ID-11', 'ID-13', 'ID-15']);
});

test('ролик без жодної дати пропускаємо, а не беремо навмання', () => {
  const out = candidates([{ id: 'БЕЗ-ДАТИ' }, { id: 'ID-01', pubDate: '2026-07-01' }],
    { today: TODAY, skipFirst: 0 });
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
