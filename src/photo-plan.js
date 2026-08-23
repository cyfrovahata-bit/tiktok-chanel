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
//
// Провідні нулі НЕ обов'язкові. Коли значення в колонку пише не наш код, а
// людина чи ChatGPT, Google Sheets розпізнає його як дату й віддає назад у
// власному форматі — зазвичай без нулів: «1.8.2026 0:01:00». Раніше такий
// рядок не розбирався, дата ставала null, і рядок падав у КІНЕЦЬ черги —
// тобто спроба посунути тему вперед давала протилежний результат.
// Приймаємо і ISO-запис «2026-08-01 00:01», який Sheets теж інколи повертає.
export function parseCreated(value) {
  const text = String(value || '').trim();
  const time = '(?:[ ,T]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?';
  const dotted = new RegExp(`^(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})${time}`).exec(text);
  const iso = dotted ? null : new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${time}`).exec(text);
  if (!dotted && !iso) return null;

  const [y, mo, d, h = '0', mi = '00', s = '00'] = dotted
    ? [dotted[3], dotted[2], dotted[1], dotted[4], dotted[5], dotted[6]]
    : [iso[1], iso[2], iso[3], iso[4], iso[5], iso[6]];
  const pad = (v, n = 2) => String(v ?? '0').padStart(n, '0');
  const ts = Date.parse(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}Z`);
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
