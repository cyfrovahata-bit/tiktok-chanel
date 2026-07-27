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

// Папка каналу на Drive для службових файлів і матеріалів власника.
export function promptFolderId() {
  return process.env.PROMPT_FOLDER_ID || '1GiHg-j0ytQyfjLU97i5vkXL6XfjIR9Uk';
}
