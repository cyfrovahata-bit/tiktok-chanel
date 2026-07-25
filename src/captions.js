// Генерація ASS-субтитрів: текст із script.txt накладається поверх чистих
// картинок синхронно з озвучкою. Один рядок script.txt = один слайд.
//
// Поведінка:
//  • слайд 1 — весь текст одразу з першого кадру (гачок читається миттєво);
//  • слайди 2..N — ПО ОДНОМУ СЛОВУ, послідовно (fade-in), з накопиченням:
//    уже показане не зникає, доки слайд не завершиться;
//  • число, записане з пробілом-роздільником («15 000»), показуємо цілим,
//    не по цифрових групах; число підсвічуємо золотим.
//
// Стабільність розкладки: увесь рядок присутній у ЄДИНОМУ ASS-івенті від
// початку, невидимі слова лише прозорі (\alpha) і проявляються \t-анімацією.
// Тому libass рахує розкладку ОДИН раз — слова ніколи не «стрибають».
import { slideOffsets, FADE_SECONDS, JCUT_SECONDS } from './montage.js';

// Хвіст у кінці слайда, коли повна фраза вже на екрані (= SLIDE_PAD у tts.js).
const PAD_APPROX = 0.5;
const FADE_IN_MS = 120; // тривалість появи слова

function hasDigit(w) { return /\d/.test(w); }
function isDigits(s) { return /^[\d\s]+$/.test(s); }

// Слова слайда → «атоми» показу: кожне слово окремо, АЛЕ сусідні суто-цифрові
// токени зливаються в одне число («15» + «000» → «15 000»).
function atomize(words) {
  const atoms = [];
  for (const w of words) {
    const prev = atoms.length ? atoms[atoms.length - 1] : null;
    if (/^\d+$/.test(w) && prev && isDigits(prev)) atoms[atoms.length - 1] = `${prev} ${w}`;
    else atoms.push(w);
  }
  return atoms;
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
// Субтитри ЗАВЖДИ ВЕЛИКИМИ ЛІТЕРАМИ — незалежно від регістру у script.txt
// (фірмовий стиль). Голос отримує нормальний регістр окремо (tts.js).
function renderWord(word) {
  const w = String(word).toUpperCase();
  if (hasDigit(w)) return `{\\c${GOLD}}${escapeText(w)}{\\c${WHITE}}`;
  return escapeText(w);
}

// Прибирає крапку (і три крапки) в кінці рядка — на слайді вона зайва.
// Знак питання й оклику лишаємо: вони несуть інтонацію напису.
// Увага: це стосується ЛИШЕ субтитрів. Для озвучки крапка потрібна —
// за нею ElevenLabs дає спадну інтонацію завершеного речення.
function stripTrailingDot(line) {
  return String(line).trim().replace(/[.…]+$/u, '').trim();
}

// Текст ASS-івенту одного слайда з появою по одному слову.
function slideText(line, isFirst, windowSec) {
  const words = stripTrailingDot(line).split(/\s+/).filter(Boolean);
  // Слайд 1 — увесь гачок одразу, без анімації.
  if (isFirst) return `{\\alpha&H00&}${words.map(renderWord).join(' ')}`;

  const atoms = atomize(words);
  const total = words.length || 1;
  let cumWords = 0;
  const parts = [];
  for (const atom of atoms) {
    // Голос слайда стартує на JCUT раніше за кадр, тож зсуваємо появу слів на
    // стільки ж (щоб не відставали), але не раніше за сам перехід (max 0).
    const revealSec = Math.max(0, windowSec * (cumWords / total) - JCUT_SECONDS);
    const tMs = Math.round(revealSec * 1000);
    const tag = `{\\alpha&HFF&\\t(${tMs},${tMs + FADE_IN_MS},\\alpha&H00&)}`;
    parts.push(tag + renderWord(atom));
    cumWords += atom.split(/\s+/).length; // атом-число може містити 2 токени
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
Style: Cap,Oswald,100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,1,0,1,6,4,8,170,170,250,1

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
export { atomize };
