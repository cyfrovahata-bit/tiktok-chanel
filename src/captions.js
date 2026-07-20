// Генерація ASS-субтитрів: текст із script.txt накладається поверх чистих
// картинок синхронно з озвучкою. Один рядок script.txt = один слайд.
//
// Поведінка (за ТЗ):
//  • слайд 1 — весь текст одразу з першого кадру (гачок читається миттєво);
//  • слайди 2..N — рядок ділиться на 2–3 смислові частини по 2–4 слова, які
//    з'являються послідовно (fade-in) і НАКОПИЧУЮТЬСЯ: уже показане не зникає,
//    доки слайд не завершиться;
//  • дуже короткий рядок (1–4 слова) — показуємо одразу повністю;
//  • число підсвічуємо золотим.
//
// Стабільність розкладки: увесь рядок присутній у ЄДИНОМУ ASS-івенті від
// початку, невидимі частини лише прозорі (\alpha) і проявляються \t-анімацією.
// Тому libass рахує розкладку ОДИН раз — слова ніколи не «стрибають».
import { slideOffsets, FADE_SECONDS } from './montage.js';

// Хвіст у кінці слайда, коли повна фраза вже на екрані (= SLIDE_PAD у tts.js).
const PAD_APPROX = 0.5;
const FADE_IN_MS = 130; // тривалість появи частини

// Короткі службові слова: ними НЕ можна завершувати частину (клеїмо до наступного).
const GLUE = new Set([
  'в', 'у', 'з', 'із', 'зі', 'до', 'від', 'для', 'по', 'за', 'під', 'над', 'при',
  'про', 'через', 'між', 'на', 'і', 'й', 'та', 'а', 'але', 'що', 'як', 'це', 'цю',
  'цей', 'ця', 'ці', 'те', 'той', 'не', 'ані', 'ще', 'вже', 'бо', 'щоб', 'аби',
  'чи', 'його', 'її', 'їх', 'свій', 'цього', 'із-за', 'один', 'одна', 'одне',
]);

function hasDigit(w) { return /\d/.test(w); }
function norm(w) { return w.toLowerCase().replace(/[«»"'`.,!?:;—–…()-]/g, ''); }

// Ділить слова слайда на 2–3 частини ~по 3 слова, не розриваючи число з
// наступним словом (одиницею) і не завершуючи частину службовим словом.
function splitChunks(words) {
  const target = 3;
  const chunks = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]);
    if (i === words.length - 1) break;
    const canBreak = cur.length >= 2 && !GLUE.has(norm(words[i])) && !hasDigit(words[i]);
    const remaining = words.length - 1 - i;
    // Розбиваємо, коли частина досягла цілі АБО далі починається число
    // (щоб число з одиницею відкривалось окремо, у момент, коли його читають).
    const nextIsNumber = hasDigit(words[i + 1]);
    if (canBreak && (cur.length >= target || nextIsNumber) && remaining >= 2) { chunks.push(cur); cur = []; }
  }
  if (cur.length) {
    if (cur.length === 1 && chunks.length) chunks[chunks.length - 1] = chunks[chunks.length - 1].concat(cur);
    else chunks.push(cur);
  }
  while (chunks.length > 3) { const last = chunks.pop(); chunks[chunks.length - 1] = chunks[chunks.length - 1].concat(last); }
  return chunks;
}

function assTime(sec) {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  let cs = Math.round((t - Math.floor(t)) * 100);
  if (cs === 100) cs = 99;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const GOLD = '&H0000D7FF&'; // золотий (ASS = &HAABBGGRR)
const WHITE = '&H00FFFFFF&';

function escapeText(t) { return t.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}'); }

// Число — золотим; решта — білим (за ТЗ випадкові слова НЕ виділяємо).
function renderWord(word) {
  if (hasDigit(word)) return `{\\c${GOLD}}${escapeText(word)}{\\c${WHITE}}`;
  return escapeText(word);
}

// Текст ASS-івенту одного слайда з накопичувальною появою частин.
function slideText(line, isFirst, windowSec) {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const chunks = (isFirst || words.length <= 4) ? [words] : splitChunks(words);
  const total = words.length || 1;
  let cum = 0;
  const parts = [];
  for (let j = 0; j < chunks.length; j++) {
    const chunk = chunks[j];
    const revealSec = isFirst ? 0 : windowSec * (cum / total);
    const tMs = Math.round(revealSec * 1000);
    // Слайд 1 (і його єдина частина) — миттєво, без анімації. Решта — fade-in.
    const tag = (isFirst && j === 0)
      ? '{\\alpha&H00&}'
      : `{\\alpha&HFF&\\t(${tMs},${tMs + FADE_IN_MS},\\alpha&H00&)}`;
    parts.push(tag + chunk.map(renderWord).join(' '));
    cum += chunk.length;
  }
  return parts.join(' ');
}

const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Oswald,100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,1,0,1,6,4,8,170,170,380,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

// Будує повний ASS для відео. lines — по рядку на слайд; durations — тривалості
// слайдів (с), ті самі, що й у монтажі. Текст кожного слайда видно від його
// початку до старту кросфейду на наступний (щоб два тексти не накладались).
export function buildAss(lines, durations) {
  const offsets = slideOffsets(durations);
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const start = offsets[i];
    const isLast = i === lines.length - 1;
    const end = isLast ? offsets[i] + durations[i] : offsets[i + 1];
    const windowSec = Math.max(0.8, durations[i] - FADE_SECONDS - PAD_APPROX);
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${slideText(lines[i], i === 0, windowSec)}`);
  }
  return HEADER + events.join('\n') + '\n';
}

// Експорт для тестів.
export { splitChunks };
