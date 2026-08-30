// Скільки дій Сторінка робить у Facebook і як швидко. Це не косметика: саме
// темп і кількість вирішують, чи виглядає автоматика як людина, що читає
// коментарі, чи як бот, який їх обробляє.
//
// Три запобіжники, і кожен закриває свій випадок:
//   • стеля на годину — від сплеску (глибокий обхід підняв сотню коментарів
//     і хоче відповісти на всі за хвилину);
//   • стеля на добу — від тихого перевищення, коли за кожну годину норма, а
//     за тиждень набігає непристойна кількість;
//   • пауза після відмови — коли Facebook уже сказав «досить», бити далі в ті
//     самі двері означає перетворити тимчасове обмеження на постійне.
//
// Усе — чисті функції над простим об'єктом: стан живе в тому самому файлі на
// Drive, що й решта пам'яті коментарів, і переживає передеплой.

export const LIMITS = {
  perHour: Number(process.env.COMMENTS_MAX_PER_HOUR) || 40,
  perDay: Number(process.env.COMMENTS_MAX_PER_DAY) || 250,
};

// Пауза після того, як Facebook поскаржився на темп.
export const COOLDOWN_MS = Number(process.env.COMMENTS_COOLDOWN_MS) || 60 * 60 * 1000;

function hourKey(now) {
  return new Date(now).toISOString().slice(0, 13); // 2026-08-30T07
}

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

// Лічильники з обнуленням: щойно змінилася година чи доба — рахунок із нуля.
export function normalize(budget, now = Date.now()) {
  const b = budget || {};
  const hour = hourKey(now);
  const day = dayKey(now);
  return {
    hour,
    day,
    inHour: b.hour === hour ? Number(b.inHour) || 0 : 0,
    inDay: b.day === day ? Number(b.inDay) || 0 : 0,
    pausedUntil: Number(b.pausedUntil) || 0,
  };
}

export function isPaused(budget, now = Date.now()) {
  return normalize(budget, now).pausedUntil > now;
}

// Чи можна зробити ще одну дію просто зараз.
export function canAct(budget, now = Date.now(), limits = LIMITS) {
  const b = normalize(budget, now);
  if (b.pausedUntil > now) return false;
  return b.inHour < limits.perHour && b.inDay < limits.perDay;
}

export function spend(budget, now = Date.now()) {
  const b = normalize(budget, now);
  return { ...b, inHour: b.inHour + 1, inDay: b.inDay + 1 };
}

// Facebook попросив зупинитися. Не пробуємо «ще разочок»: наступні проходи
// мовчать, доки не мине пауза.
export function pause(budget, now = Date.now(), ms = COOLDOWN_MS) {
  return { ...normalize(budget, now), pausedUntil: now + ms };
}

// Помилки, після яких треба спинитися, а не повторювати.
export function isRateLimit(message) {
  return /rate limit|too many|request limit|#4\b|#17\b|#32\b|#341\b|temporarily blocked|spam/i
    .test(String(message || ''));
}

// Пауза між діями. Facebook дивиться не лише на кількість за годину, а й на
// щільність: двадцять дій за десять секунд — це впізнаваний слід бота.
export const PAUSE_MS = Number(process.env.COMMENTS_PAUSE_MS) || 4000;

export function nextPauseMs(random = Math.random) {
  // Розкид ±40%: рівний інтервал сам по собі виглядає машинним.
  return Math.round(PAUSE_MS * (0.6 + random() * 0.8));
}
