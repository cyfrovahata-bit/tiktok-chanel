// Київський час і папка з матеріалами. Дрібні спільні помічники, які раніше
// жили в drafts.js — сам модуль чернеток пішов разом із генерацією тем через
// OpenAI API (теми тепер придумує ChatGPT за відкладеним завданням о 08:00).

// Дата в Києві як YYYY-MM-DD.
export function kyivToday(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// Хвилини від початку доби за київським часом.
export function kyivMinutes(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  return Number(p.find((x) => x.type === 'hour').value) * 60
    + Number(p.find((x) => x.type === 'minute').value);
}

const pad = (n) => String(n).padStart(2, '0');

// Київська стінна дата-час моменту як «YYYY-MM-DDTHH:mm».
function kyivStamp(at) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}

// Момент часу, який у Києві показує вказані дату й годину.
//
// Через зміщення (яке ще й змінюється двічі на рік) прямого способу немає:
// беремо ту саму стінну годину як UTC, дивимось, котра при цьому в Києві, і
// зсуваємо на різницю. Другої ітерації достатньо навіть у добу переведення
// стрілок, коли перша поправка сама змінює зміщення.
export function kyivInstant(dateStr, hour, minute = 0) {
  const target = Date.parse(`${dateStr}T${pad(hour)}:${pad(minute)}:00Z`);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    guess -= Date.parse(`${kyivStamp(new Date(guess))}:00Z`) - target;
  }
  return new Date(guess);
}

// Найближчі `count` спрацювань щоденного розкладу (години за київським часом).
// Повертає моменти суворо в майбутньому, від найранішого.
export function nextDailyTimes(hours, count, now = new Date()) {
  const wanted = [...new Set(hours)].filter((h) => Number.isInteger(h)).sort((a, b) => a - b);
  if (!wanted.length || count <= 0) return [];
  const out = [];
  const seen = new Set();
  for (let shift = 0; shift < 30 && out.length < count; shift++) {
    const date = kyivToday(new Date(now.getTime() + shift * 86_400_000));
    if (seen.has(date)) continue;
    seen.add(date);
    for (const hour of wanted) {
      if (out.length >= count) break;
      const at = kyivInstant(date, hour);
      if (at.getTime() > now.getTime()) out.push(at);
    }
  }
  return out;
}

// Папка каналу на Drive для службових файлів і матеріалів власника.
export function promptFolderId() {
  return process.env.PROMPT_FOLDER_ID || '1GiHg-j0ytQyfjLU97i5vkXL6XfjIR9Uk';
}
