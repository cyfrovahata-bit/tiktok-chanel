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

// Тексти слайдів із промту, по порядку. Немає блоку — порожній масив.
export function parseSlideLines(prompt) {
  const m = LIST_RE.exec(String(prompt || ''));
  if (!m) return [];
  return m[2]
    .split('\n')
    .map((l) => l.replace(/^[ \t]*\d+[.)][ \t]*/, '').trim())
    .filter(Boolean);
}

// Тема з рядка «ТЕМА: …» (для заголовка картки, якщо колонка C відстала).
export function parseTheme(prompt) {
  const m = /^ТЕМА:[ \t]*(.+)$/m.exec(String(prompt || ''));
  return m ? m[1].trim() : '';
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
