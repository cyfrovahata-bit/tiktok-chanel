// Українські числівники словами — ЛИШЕ для озвучки (щоб ElevenLabs не читав
// числа «російською»/цифрами). Субтитрів не стосується: там лишаються цифри.
const ONES = ['', 'один', 'два', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
const ONES_F = ['', 'одна', 'дві', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
const TEENS = ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять', "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять"];
const TENS = ['', '', 'двадцять', 'тридцять', 'сорок', "п'ятдесят", 'шістдесят', 'сімдесят', 'вісімдесят', "дев'яносто"];
const HUNDREDS = ['', 'сто', 'двісті', 'триста', 'чотириста', "п'ятсот", 'шістсот', 'сімсот', 'вісімсот', "дев'ятсот"];
// [одн., 2-4, 5+, жіночий рід?]
const SCALES = [
  null,
  ['тисяча', 'тисячі', 'тисяч', true],
  ['мільйон', 'мільйони', 'мільйонів', false],
  ['мільярд', 'мільярди', 'мільярдів', false],
];

function group3(n, feminine) {
  const parts = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const t = Math.floor(rest / 10);
  const o = rest % 10;
  if (h) parts.push(HUNDREDS[h]);
  if (t === 1) parts.push(TEENS[o]);
  else {
    if (t >= 2) parts.push(TENS[t]);
    if (o) parts.push((feminine ? ONES_F : ONES)[o]);
  }
  return parts.join(' ');
}

// Форма масштабного слова (тисяча/тисячі/тисяч) за останніми цифрами.
function pluralScale(n, forms) {
  const m100 = n % 100;
  const m10 = n % 10;
  if (m100 >= 11 && m100 <= 14) return forms[2];
  if (m10 === 1) return forms[0];
  if (m10 >= 2 && m10 <= 4) return forms[1];
  return forms[2];
}

export function numberToUkrainian(num) {
  const value = Math.trunc(Math.abs(Number(num)));
  if (!Number.isFinite(value)) return String(num);
  if (value === 0) return 'нуль';
  const groups = [];
  let n = value;
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
  const words = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;
    const scale = SCALES[i];
    // «1000» → «тисяча» (без «одна»), напр. рік «1947» → «тисяча дев'ятсот…».
    if (scale && scale[3] && g === 1) { words.push(scale[0]); continue; }
    words.push(group3(g, scale ? scale[3] : false));
    if (scale) words.push(pluralScale(g, scale));
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

// Замінює числа в тексті на слова (для голосу). Підтримує пробіл-роздільник
// тисяч («15 000», включно з нерозривним пробілом). Числа, зліплені з
// літерами («3D», «COVID19»), НЕ чіпає.
export function numbersToWords(text) {
  return String(text).replace(
    /(?<![\p{L}\d])(\d{1,3}(?:[  ]\d{3})+|\d+)(?![\p{L}\d])/gu,
    (m) => numberToUkrainian(m.replace(/[  ]/g, '')),
  );
}
