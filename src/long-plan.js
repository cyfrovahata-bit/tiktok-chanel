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
  // Ролики, опубліковані до цієї дати, у збірки не йдуть: рання партія слабша
  // за нинішню, і в довгому відео це чути одразу. Межу назвав власник,
  // передивившись архів.
  notBefore: '2026-07-20',
  skipFirst: 0,       // додаткова відсічка «перших N рядків», якщо знадобиться
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
  notBefore = DEFAULTS.notBefore,
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
      if (notBefore && (!shown || shown < notBefore)) return false;
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

// Куди йде сама довга збірка. Facebook публікується вручну, тож автоматика
// звільняє слот лише там, де ввечері справді вийде довге відео.
export const LONG_VIDEO_PLATFORMS = ['youtube', 'facebook'];

// Чи віддано вечірній слот цієї платформи довгій збірці. TikTok та Instagram
// довгого відео не отримують узагалі — їхній шортс о 18:00 виходить як
// завжди. А от на YouTube і Facebook цей ролик не вийде НІКОЛИ, навіть
// завтра: інакше глядач побачив би той самий сюжет двічі — окремо й усередині
// збірки. У монтаж наступних збірок він при цьому потрапляє нарівні з рештою.
export function shortDisplacedByLong(platform, slotHour, now = new Date(), planned = null) {
  // planned = false означає, що добірку сьогодні скасували (не приїхало
  // прев'ю) — тоді вечірній слот повертається шортсу, як у звичайний день.
  if (!(planned ?? isCompilationDay(now))) return false;
  if (Number(slotHour) !== COMPILATION_HOUR) return false;
  return LONG_VIDEO_PLATFORMS.includes(String(platform));
}

// --- Тема збірки -------------------------------------------------------------
// П'ять роликів однієї теми («5 замків України») тримаються купи краще, ніж
// п'ять випадкових: у глядача з'являється причина додивитися, а в обкладинки —
// що обіцяти. Тему шукає модель серед назв придатних роликів; наша справа —
// поставити їй рамки й перевірити відповідь.

export function buildThemePrompt(items, size, { avoidTitles = [], loose = false } = {}) {
  const list = items.map((it) => `${it.id} | ${it.title || it.theme || ''}`).join('\n');

  // Тижнева добірка на 15 сюжетів однією темою не збирається — там правило
  // інше: беремо найсильніше й даємо ЩОРАЗУ ІНШУ загальну назву, щоб
  // п'ятниці не злилися в один нескінченний ролик.
  const rule = loose
    ? `ПРАВИЛО: спільна тема не обов'язкова — це тижнева добірка найкращого.
Бери найрізноманітніші й найцікавіші сюжети, щоб поруч не стояли два схожі.
Назва має бути ЗАГАЛЬНА, але щоразу НОВА за формулюванням.`
    : `ГОЛОВНЕ ПРАВИЛО: сюжети мають триматися купи спільною темою — епоха, стихія
(вода, гори, підземелля), тип об'єкта (замки, мости, винаходи), одна галузь.
Добірка «5 замків України» працює, «5 випадкових фактів» — ні.

АЛЕ ТЕМА НЕ МАЄ ПРАВА БРЕХАТИ. Вузьку тему бери, ЛИШЕ якщо в списку
справді набирається рівно ${size} сюжетів саме про це. Порахуй їх, перш ніж
назвати тему. Три замки, собор і бур'ян — це НЕ «${size} замків»: собор не
замок, і глядач це побачить у перші секунди.

ЯКЩО НА ВУЗЬКУ ТЕМУ НЕ ВИСТАЧАЄ:
• візьми ширшу, під яку чесно підпадають УСІ ${size} («Кам'яна Україна»,
  «Спадщина, яку встигли врятувати»), а не вузьку з добором збоку;
• жодна тема не набирається — бери те, що найкраще пасує одне до одного, і
  назви це чесно й широко. Порожню відповідь не давай ніколи.`;

  const avoid = avoidTitles.length
    ? `\n\nЦІ НАЗВИ ВЖЕ БУЛИ — не повторюй їх і не роби схожих:\n${avoidTitles.map((t) => `• ${t}`).join('\n')}`
    : '';

  return `Ти редактор українського каналу коротких фактів. Нижче — список готових
сюжетів у форматі «ID | назва». Твоє завдання — зібрати добірку рівно з ${size} сюжетів.

${rule}

НАЗВА ДОБІРКИ — це те, що глядач побачить на обкладинці: коротко, до 4 слів,
без лапок і без слова «добірка». Наприклад: «5 замків України», «Українські
винаходи», «Підземна Україна».${avoid}

ПІДПИС ДО КОЖНОГО СЮЖЕТУ — 2–3 слова, які диктор скаже перед ним:
«Факт другий. Хотинська фортеця». Це назва самого об'єкта чи явища, а не
переказ сюжету і не його розгадка. Без лапок і без крапки в кінці.

Відповідь — ЛИШЕ JSON, без пояснень і без розмітки:
{"theme":"одним реченням, що спільного","title":"коротка назва",
 "picks":[{"id":"ID","label":"Хотинська фортеця"}]}

picks — рівно ${size} штук, ID беруться зі списку нижче. Нічого не вигадуй.

СПИСОК:
${list}`;
}

// Запасний підпис, якщо модель його не дала. Назви в таблиці здебільшого
// збудовані як «Об'єкт: пояснення», тож частина до двокрапки — саме те, що
// треба. Без двокрапки беремо перші слова: гірше, ніж від моделі, але краще,
// ніж мовчання.
export function shortLabel(title) {
  const full = String(title || '').replace(/[«»"]/g, '').trim();
  if (!full) return '';
  const head = full.split(':')[0].trim();
  const base = head.length >= 3 && head.length <= 40 ? head : full;
  return base.split(/\s+/).slice(0, 4).join(' ').replace(/[,.;:–—-]+$/, '').trim();
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

  // Модель може відповісти і новим форматом (picks із підписами), і старим
  // (самі ids) — приймаємо обидва, бо втратити добірку через форму відповіді
  // було б безглуздо.
  const raw = Array.isArray(data.picks) ? data.picks
    : (Array.isArray(data.ids) ? data.ids.map((id) => ({ id })) : []);
  const ids = [];
  const labels = new Map();
  for (const entry of raw) {
    const id = String(entry?.id ?? entry ?? '').trim();
    if (!known.has(id) || ids.includes(id)) continue;
    ids.push(id);
    const label = String(entry?.label || '').trim();
    if (label) labels.set(id, label);
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

  const chosen = ids.slice(0, size);
  return {
    ids: chosen,
    // Підпис має бути в кожного: без нього оголошення лишиться самим номером.
    labels: chosen.map((id) => labels.get(id) || shortLabel(known.get(id)?.title)),
    theme: String(data.theme || '').trim(),
    title: String(data.title || '').trim(),
    toppedUp,
  };
}

// --- Чесна назва -------------------------------------------------------------
// Перший прохід моделі обирає сюжети Й одразу дає назву — і саме там ламається:
// назвавши тему «5 замків України», модель добирає до трьох наявних замків
// собор і бур'ян, а назву лишає стару. Глядач бачить обман у перші секунди.
//
// Тому назву перепитуємо ОКРЕМО і вже по ФАКТИЧНО обраному набору, а модель
// має перелічити ID, які ця назва чесно накриває. Не накрила всіх — назва
// відхиляється, і це перевіряється кодом, а не на віру.

export function buildTitlePrompt(items, { avoidTitles = [] } = {}) {
  const list = items.map((it) => `${it.id} | ${it.title || it.theme || ''}`).join('\n');
  const avoid = avoidTitles.length
    ? `\n\nЦІ НАЗВИ ВЖЕ БУЛИ — не повторюй їх і не роби схожих:\n${avoidTitles.map((t) => `• ${t}`).join('\n')}`
    : '';

  return `Ти редактор українського каналу «Чи Ви Знали?». Набір сюжетів для довгої
добірки ВЖЕ зібрано — міняти його не можна. Твоє завдання одне: дати цьому
набору назву, яка стоятиме на обкладинці.

НАБІР (${items.length} сюжетів, «ID | назва»):
${list}

ГОЛОВНА ВИМОГА — НАЗВА НЕ БРЕШЕ.
Назва мусить чесно накривати ВСІ ${items.length} сюжетів до одного. Якщо серед
них лише три замки, «${items.length} замків» — брехня; шукай ширше спільне:
матеріал, епоху, стихію, долю об'єктів, спільне відчуття.
Число в назві пиши, ЛИШЕ якщо всі ${items.length} справді про одне й те саме.

ЯКА НАЗВА ПОТРІБНА
• До 4 слів, без лапок, без слова «добірка», без КАПСУ й емодзі.
• Інтригує, а не описує: обіцяє відкриття, не переказує зміст.
• Приклади робочих: «Кам'яна Україна», «Те, що ледь не зникло»,
  «Підземна Україна», «Україна, якої ти не знав».${avoid}

ПЕРЕВІР СЕБЕ
Пройди по кожному ID зі списку й спитай: ця назва про нього теж? Перелічи в
полі covers ID усіх, кого назва накриває чесно. Якщо вийшло менше ніж
${items.length} — назва невдала, придумай ширшу й перевір заново.

Відповідь — ЛИШЕ JSON, без розмітки:
{"title":"коротка назва","theme":"одним реченням, що спільного","covers":["ID", "ID"]}`;
}

// Розбір відповіді. honest === true означає, що назва накрила ВЕСЬ набір, і
// лише тоді її можна ставити на обкладинку.
export function parseTitleAnswer(answer, ids) {
  const want = new Set(ids.map(String));
  let data = {};
  try {
    const text = String(answer || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    data = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : {};
  } catch {
    data = {};
  }
  const covers = new Set(
    (Array.isArray(data.covers) ? data.covers : [])
      .map((id) => String(id).trim())
      .filter((id) => want.has(id)),
  );
  const title = String(data.title || '').replace(/^[«"]|[»"]$/g, '').trim();
  const missed = ids.map(String).filter((id) => !covers.has(id));
  return {
    title,
    theme: String(data.theme || '').trim(),
    covers: [...covers],
    missed,
    honest: Boolean(title) && missed.length === 0,
  };
}

// Запасні назви — на випадок, коли модель так і не дала чесної. Вони свідомо
// широкі: під них підпадає будь-який набір фактів про Україну, тож збрехати
// ними неможливо. Беремо першу, якої ще не було останніми днями.
export const NEUTRAL_TITLES = [
  'Україна, якої ти не знав',
  'Несподівана Україна',
  'Маловідома Україна',
  'Україна зблизька',
  'Інша Україна',
];

export function neutralTitle(size, avoidTitles = []) {
  const used = new Set(avoidTitles.map((t) => String(t).trim().toLowerCase()));
  const free = NEUTRAL_TITLES.find((t) => !used.has(t.toLowerCase()));
  return free || `${size} фактів про Україну`;
}

// Підпис, який диктор скаже після «Факт третій». Модель іноді віддає замість
// назви об'єкта початок речення — «Як кормова культура перетворилася». Диктор
// прочитає це як обірвану думку, тож такий підпис краще прибрати зовсім:
// «Факт п'ятий.» звучить нормально, «Факт п'ятий. Як кормова культура
// перетворилася.» — ні.
// \b тут не працює: він рахує межу слова лише за латиницею, і «як » після
// кирилиці межею не вважається. Тому — явний пробіл після слова.
const SENTENCE_START = /^(як|чому|що|де|коли|хто|скільки|навіщо|чи)\s/i;

export function cleanLabel(label) {
  const text = String(label || '').replace(/[«»"]/g, '').replace(/[.!?…]+$/, '').trim();
  if (!text) return '';
  if (SENTENCE_START.test(text)) return '';
  // Підпис довший за півдесятка слів — це вже переказ, а не назва об'єкта.
  if (text.split(/\s+/).length > 5) return '';
  return text;
}
