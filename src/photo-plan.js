// Коли до якого рядка NEW дійде черга на малювання фото.
//
// Малює не наш код, а відкладене завдання ChatGPT (prompts/copy-2-foto.txt).
// Його правило: «Є кілька — бери НАЙСТАРІШИЙ за колонкою I "Створено". За
// один запуск обробляй РІВНО ОДИН рядок». Тобто за одну годину розкладу
// зникає рівно один рядок, і показувати всім спільний найближчий час не
// можна — другий чекатиме наступної години, третій ще наступної.

import { nextDailyTimes } from './kyiv.js';

// «28.07.2026 22:43:31» → мілісекунди. Це стінний київський час, але для
// сортування зміщення не важить: усі значення в одній зоні.
export function parseCreated(value) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ ,]+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(
    String(value || '').trim(),
  );
  if (!m) return null;
  const [, d, mo, y, h = '00', mi = '00', s = '00'] = m;
  const ts = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(ts) ? null : ts;
}

// Мапа id → ISO-час, коли цей рядок піде на малювання.
// Порядок: за «Створено», а рядки з нерозпізнаною датою — у кінець, зберігаючи
// порядок таблиці (нові дописуються знизу, тож він теж хронологічний).
export function photoSchedule(pending, hours, now = new Date()) {
  const rows = (pending || []).filter((it) => it && it.id);
  const order = rows
    .map((it, i) => ({ it, i, ts: parseCreated(it.created) }))
    .sort((a, b) => {
      if (a.ts != null && b.ts != null && a.ts !== b.ts) return a.ts - b.ts;
      if (a.ts == null && b.ts != null) return 1;
      if (a.ts != null && b.ts == null) return -1;
      return a.i - b.i;
    });
  const slots = nextDailyTimes(hours, order.length, now);
  const at = new Map();
  order.forEach((entry, n) => {
    if (slots[n]) at.set(entry.it.id, slots[n].toISOString());
  });
  return at;
}
