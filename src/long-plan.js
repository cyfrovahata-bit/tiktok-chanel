// План довгих збірок: КОЛИ вони виходять і ЯКІ ролики до них беруться.
//
// Розклад (київський час, 18:00):
//   неділя  — збірка з 5 сюжетів
//   вівторок — збірка з 5 сюжетів
//   п'ятниця — збірка з 15 сюжетів
// У ці дні шортс о 18:00 не виходить, а зсувається на наступний слот.
//
// Увесь відбір — чисті функції над рядками таблиці: рішення «який ролик
// можна брати» надто дороге, щоб перевіряти його на живому Drive.
import { kyivToday } from './kyiv.js';

// Розмір збірки за днем тижня. Ключ — день у нумерації JS (0 — неділя).
export const SET_BY_WEEKDAY = { 0: 5, 2: 5, 5: 15 };
export const COMPILATION_HOUR = 18;

// День тижня КИЇВСЬКОЇ дати. Рахуємо саме її, а не UTC: о 23:30 у Києві вже
// наступна доба, і збірка поїхала б на день назад.
export function kyivWeekday(now = new Date()) {
  const [y, m, d] = kyivToday(now).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Скільки сюжетів іде сьогодні: 5, 15 або null (не день збірки).
export function plannedSize(now = new Date()) {
  return SET_BY_WEEKDAY[kyivWeekday(now)] ?? null;
}

export function isCompilationDay(now = new Date()) {
  return plannedSize(now) != null;
}

// Скільки діб минуло між двома датами «YYYY-MM-DD». Порівнюємо саме дати, а
// не моменти: у таблиці час публікації не зберігається, і будь-яка спроба
// вважати години дала б хибну точність.
export function daysBetween(fromDate, toDate) {
  const at = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = at(fromDate);
  const b = at(toDate);
  if (a == null || b == null) return null;
  return Math.round((b - a) / 86400000);
}

// Дата, коли ролик побачив глядач. Колонка «Опубліковано» заповнюється
// вручну і може бути порожньою — тоді падаємо на дату з самого ID
// (AUTO-20260816-1221 → 2026-08-16): вона завжди є і не пізніша за публікацію.
export function shownOn(item) {
  const pub = String(item?.pubDate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(pub)) return pub.slice(0, 10);
  const m = /-(\d{4})(\d{2})(\d{2})-/.exec(`-${String(item?.id || '')}`);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export const DEFAULTS = {
  skipFirst: 10,      // найперші ролики каналу — слабкі, у збірки не йдуть
  freshDays: 10,      // щойно показане глядач пам'ятає, повтор дратує
  cooldownDays: 21,   // як довго ролик відпочиває після попередньої збірки
};

// Ролики, з яких МОЖНА збирати. published — рядки таблиці в порядку таблиці,
// тобто найстаріші перші.
//
// compiledAt(id) → «YYYY-MM-DD» останньої збірки з цим роликом або null.
// Мітку ставить сам монтаж (videos.markCompiled), тож пам'ять про повтори
// живе на Drive і переживає передеплой.
export function candidates(published, {
  now = new Date(),
  today = null,
  excludeIds = [],
  skipFirst = DEFAULTS.skipFirst,
  freshDays = DEFAULTS.freshDays,
  cooldownDays = DEFAULTS.cooldownDays,
  compiledAt = () => null,
} = {}) {
  const day = today || kyivToday(now);
  const banned = new Set(excludeIds.map(String));
  return published
    .slice(skipFirst)
    .filter((item) => {
      if (banned.has(String(item.id))) return false;

      const shown = shownOn(item);
      const sinceShown = daysBetween(shown, day);
      // Дати немає взагалі — ролик пропускаємо: краще не взяти придатний,
      // ніж поставити в збірку вчорашній.
      if (sinceShown == null || sinceShown < freshDays) return false;

      if (cooldownDays > 0) {
        const used = compiledAt(item.id);
        const sinceUsed = used ? daysBetween(used, day) : null;
        if (sinceUsed != null && sinceUsed < cooldownDays) return false;
      }
      return true;
    });
}

// --- Тема збірки -------------------------------------------------------------
// П'ять роликів однієї теми («5 замків України») тримаються купи краще, ніж
// п'ять випадкових: у глядача з'являється причина додивитися, а в обкладинки —
// що обіцяти. Тему шукає модель серед назв придатних роликів; наша справа —
// поставити їй рамки й перевірити відповідь.

export function buildThemePrompt(items, size) {
  const list = items.map((it) => `${it.id} | ${it.title || it.theme || ''}`).join('\n');
  return `Ти редактор українського каналу коротких фактів. Нижче — список готових
сюжетів у форматі «ID | назва». Твоє завдання — зібрати добірку рівно з ${size} сюжетів.

ГОЛОВНЕ ПРАВИЛО: сюжети мають триматися купи спільною темою — епоха, стихія
(вода, гори, підземелля), тип об'єкта (замки, мости, винаходи), одна галузь.
Добірка «5 замків України» працює, «5 випадкових фактів» — ні.

ЯКЩО НА ТЕМУ НЕ ВИСТАЧАЄ:
• бракує 1–2 сюжетів — добери їх із найближчої суміжної теми, а назву дай
  ширшу, щоб вона чесно накривала весь набір;
• жодна тема не набирається — бери те, що найкраще пасує одне до одного, і
  назви це чесно й широко. Порожню відповідь не давай ніколи.

НАЗВА ДОБІРКИ — це те, що глядач побачить на обкладинці: коротко, до 4 слів,
без лапок і без слова «добірка». Наприклад: «5 замків України», «Українські
винаходи», «Підземна Україна».

Відповідь — ЛИШЕ JSON, без пояснень і без розмітки:
{"theme":"одним реченням, що спільного","title":"коротка назва","ids":["ID","ID"]}

ids — рівно ${size} штук, узятих зі списку нижче. Нічого не вигадуй.

СПИСОК:
${list}`;
}

// Розбирає відповідь моделі. Ніколи не кидає через кривий JSON і ніколи не
// повертає менше, ніж треба: добірка має вийти навіть тоді, коли модель
// відповіла абияк — доберемо найстарішими придатними.
export function parseThemeSet(answer, items, size) {
  const known = new Map(items.map((it) => [String(it.id), it]));
  let data = {};
  try {
    const text = String(answer || '').replace(/^```(?:json)?/i, '').replace(/```$/, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    data = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : {};
  } catch {
    data = {};
  }

  const ids = [];
  for (const raw of Array.isArray(data.ids) ? data.ids : []) {
    const id = String(raw).trim();
    if (known.has(id) && !ids.includes(id)) ids.push(id);
  }
  // Модель могла назвати менше, ніж треба, або вигадати неіснуючий ID.
  // Добираємо найстарішими з тих, що лишились: краще менш однорідна добірка,
  // ніж жодної.
  const toppedUp = ids.length < size;
  for (const item of items) {
    if (ids.length >= size) break;
    const id = String(item.id);
    if (!ids.includes(id)) ids.push(id);
  }

  return {
    ids: ids.slice(0, size),
    theme: String(data.theme || '').trim(),
    title: String(data.title || '').trim(),
    toppedUp,
  };
}
