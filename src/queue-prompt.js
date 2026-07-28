// Розбір і правка промту, що лежить у колонці G рядка черги.
//
// Тексти слайдів усередині промту зустрічаються ДВІЧІ: списком «ТЕКСТИ
// СЛАЙДІВ» і ще раз у брифі кожного кадру як «(рядок: «…»)». Якщо правити
// лише перше місце, ChatGPT отримає промт, який сам собі суперечить, тож
// заміна завжди йде в обидва.
//
// Формат промту задає завдання о 08:00/17:00 — тут ми на нього лише
// спираємось і нічого не нав'язуємо: коли блок не знайдено, повертаємо
// порожній список, і мінідодаток просто не покаже рядки для правки.

const LIST_RE = /(ТЕКСТИ СЛАЙДІВ[^\n]*\n)((?:[ \t]*\d+[.)][^\n]*\n)+)/;

// Промт першого етапу (розбити сюжет власника на слайди) сам НЕСЕ ВСЕРЕДИНІ
// порожній шаблон майбутнього сценарію — із заглушками у фігурних дужках.
// Це ще не сценарій, і «{рядок 1}» не можна показувати як текст слайда.
const TEMPLATE_RE = /ШАБЛОН ДЛЯ КОЛОНКИ G/;
const PLACEHOLDER_RE = /^\{[^{}]*\}$/;

// Тексти слайдів із промту, по порядку. Немає блоку — порожній масив.
export function parseSlideLines(prompt) {
  const text = String(prompt || '');
  if (TEMPLATE_RE.test(text)) return [];
  const m = LIST_RE.exec(text);
  if (!m) return [];
  const lines = m[2]
    .split('\n')
    .map((l) => l.replace(/^[ \t]*\d+[.)][ \t]*/, '').trim())
    .filter(Boolean);
  // Незаповнений шаблон без свого заголовка — теж не сценарій.
  return lines.some((l) => PLACEHOLDER_RE.test(l)) ? [] : lines;
}

// Тема з рядка «ТЕМА: …» (для заголовка картки, якщо колонка C відстала).
export function parseTheme(prompt) {
  const text = String(prompt || '');
  if (TEMPLATE_RE.test(text)) return '';
  const m = /^ТЕМА:[ \t]*(.+)$/m.exec(text);
  if (!m) return '';
  const theme = m[1].trim();
  return PLACEHOLDER_RE.test(theme) ? '' : theme;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Підставляє нові тексти слайдів у промт. Кількість не змінюємо: скільки було
// рядків, стільки й лишається — інакше розійдеться з колонкою «Слайдів» і з
// кількістю фото, яку малюватиме ChatGPT.
export function applySlideLines(prompt, lines) {
  const text = String(prompt || '');
  const old = parseSlideLines(text);
  if (!old.length || old.length !== lines.length) {
    throw new Error(`Очікував ${old.length || '?'} рядків, отримав ${lines.length}`);
  }
  const clean = lines.map((l) => String(l).replace(/\s+/g, ' ').trim());
  if (clean.some((l) => !l)) throw new Error('Порожній рядок слайда');

  // 1. Список «ТЕКСТИ СЛАЙДІВ».
  let out = text.replace(LIST_RE, (_all, head, body) => {
    const indent = /^([ \t]*)\d/.exec(body)?.[1] ?? '';
    return head + clean.map((l, i) => `${indent}${i + 1}. ${l}`).join('\n') + '\n';
  });

  // 2. Дублі в брифах кадрів: (рядок: «…»).
  old.forEach((prev, i) => {
    if (prev === clean[i]) return;
    out = out.replace(new RegExp(`(рядок:\\s*«)${escapeRe(prev)}(»)`, 'g'), `$1${clean[i]}$2`);
  });
  return out;
}
