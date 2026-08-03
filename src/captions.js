// Генерація ASS-субтитрів: текст із script.txt накладається поверх чистих
// картинок синхронно з озвучкою. Один рядок script.txt = один слайд.
//
// Поведінка (перероблено за зразком, який дав власник):
//  • рядок слайда ріжеться на ФРАГМЕНТИ по 1–3 слова;
//  • на екрані одночасно максимум два: попередній — дрібніший і приглушений,
//    поточний — великий і яскравий;
//  • фрагменти ЗМІНЮЮТЬ одне одного синхронно з мовленням, а не накопичуються.
//
// Навіщо. Раніше весь рядок висів у кадрі до кінця слайда, тож репліка мусила
// бути телеграфною — інакше текст займав півекрана. Через це сценарій не міг
// бути оповіданням: будь-яке нормальне речення перетворювало кадр на стіну
// букв. Тепер на екрані ніколи не більше трьох слів, тому озвучка може бути
// повноцінним літературним текстом, а субтитр лишається дослівно тим самим —
// просто поданим порціями.
//
// Число, записане з пробілом-роздільником («15 000»), не розривається між
// фрагментами й підсвічується золотим.
import { slideOffsets, FADE_SECONDS, JCUT_SECONDS } from './montage.js';

// Хвіст у кінці слайда, коли остання фраза вже на екрані (= SLIDE_PAD у tts.js).
const PAD_APPROX = 0.5;
const FADE_IN_MS = 90;          // поява фрагмента
const MAX_CHUNK_WORDS = 3;      // більше трьох слів на екран не пускаємо
const LONG_WORD = 11;           // довге слово показуємо саме
const SHORT_WORD = 5;           // з коротких можна зібрати трійку

function hasDigit(w) { return /\d/.test(w); }
function isDigits(s) { return /^[\d\s]+$/.test(s); }

// Слова слайда → «атоми»: кожне слово окремо, АЛЕ сусідні суто-цифрові
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

// Атоми → фрагменти по 1–3 слова. Межу речення (кома, крапка, тире) поважаємо:
// фраза не має «перетікати» через розділовий знак — на слух там пауза, і в
// кадрі текст має мінятися саме там.
export function chunkAtoms(atoms) {
  const chunks = [];
  let current = [];
  const flush = () => { if (current.length) { chunks.push(current.join(' ')); current = []; } };
  for (const atom of atoms) {
    const bare = atom.replace(/[^\p{L}\p{N}]/gu, '');
    const alone = bare.length >= LONG_WORD || hasDigit(atom);
    if (alone && current.length) flush();
    current.push(atom);
    const words = current.reduce((n, a) => n + a.split(/\s+/).length, 0);
    const allShort = current.every((a) => a.replace(/[^\p{L}\p{N}]/gu, '').length <= SHORT_WORD);
    const limit = allShort ? MAX_CHUNK_WORDS : 2;
    if (alone || words >= limit || /[.,;:!?…—–]$/u.test(atom)) flush();
  }
  flush();
  return mergeTiny(chunks);
}

// Дрібний фрагмент («У», «І», «ТА») отримав би частку секунди — на екрані це
// мигтіння, яке неможливо прочитати. Такі приклеюємо до сусіда: до наступного,
// а для останнього — до попереднього.
function mergeTiny(chunks) {
  const merged = [];
  for (let i = 0; i < chunks.length; i++) {
    const short = chunks[i].replace(/[^\p{L}\p{N}]/gu, '').length < 4;
    const wordsWithNext = i + 1 < chunks.length
      ? chunks[i].split(/\s+/).length + chunks[i + 1].split(/\s+/).length
      : Infinity;
    if (short && wordsWithNext <= MAX_CHUNK_WORDS) {
      chunks[i + 1] = `${chunks[i]} ${chunks[i + 1]}`;
      continue;
    }
    if (short && merged.length) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${chunks[i]}`;
      continue;
    }
    merged.push(chunks[i]);
  }
  return merged;
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
const PREV_SIZE = 62;       // кегль попереднього (згасаючого) фрагмента
const PREV_ALPHA = '&H90&'; // його прозорість
const ACCENT_SIZE = 138;    // кегль акцентного фрагмента (базовий — у стилі Cap)
const ACCENT_LETTERS = 8;   // від скількох літер самостійне слово вважаємо акцентом

// Акцент — те, заради чого фрагмент існує: число або окреме довге слово, на
// якому тримається фраза («ПСИХОЛОГІЯ», «НАЙВАЖЛИВІШЕ», «27 572»). Розмітки в
// script.txt свідомо немає: зайві символи в рядку потрапили б і в озвучку.
function isAccent(chunk) {
  if (hasDigit(chunk)) return true;
  const words = chunk.trim().split(/\s+/);
  return words.length === 1 && words[0].replace(/[^\p{L}]/gu, '').length >= ACCENT_LETTERS;
}

function escapeText(t) { return t.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}'); }

// Число — золотим; решта — білим. Субтитри ЗАВЖДИ ВЕЛИКИМИ ЛІТЕРАМИ
// (фірмовий стиль). Голос отримує нормальний регістр окремо (tts.js).
function renderChunk(chunk) {
  const w = String(chunk).toUpperCase();
  if (hasDigit(w)) return `{\\c${GOLD}}${escapeText(w)}{\\c${WHITE}}`;
  return escapeText(w);
}

// Прибирає розділові знаки в кінці фрагмента — у кадрі вони зайві.
// Знак питання й оклику лишаємо: вони несуть інтонацію.
// Увага: це стосується ЛИШЕ субтитрів. Озвучка отримує текст із пунктуацією —
// за нею рушій будує інтонацію.
function stripTrailingPunct(chunk) {
  return String(chunk).trim().replace(/[.,;:…—–]+$/u, '').trim();
}

// Довжина фрагмента в «вимовних» одиницях. Пропорційно їй розподіляємо час:
// за кількістю літер це точніше, ніж за кількістю слів («і» та «найважливіше»
// звучать по-різному).
function weight(chunk) {
  return Math.max(1, chunk.replace(/\s+/g, '').length);
}

// Події одного слайда: по одній на фрагмент. Кожна показує попередній
// фрагмент (дрібно, приглушено) над поточним (великим і яскравим).
function slideEvents(line, startSec, endSec, windowSec) {
  const words = String(line).trim().split(/\s+/).filter(Boolean);
  const chunks = chunkAtoms(atomize(words)).map(stripTrailingPunct).filter(Boolean);
  if (!chunks.length) return [];

  const weights = chunks.map(weight);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  // Голос слайда стартує на JCUT раніше за кадр — зсуваємо появу так само,
  // але не раніше за сам перехід.
  const shift = startSec === 0 ? 0 : JCUT_SECONDS;

  const events = [];
  let cum = 0;
  for (let i = 0; i < chunks.length; i++) {
    const from = startSec + Math.max(0, (windowSec * cum) / totalWeight - shift);
    cum += weights[i];
    const rawTo = startSec + Math.max(0, (windowSec * cum) / totalWeight - shift);
    const to = i === chunks.length - 1 ? endSec : Math.min(rawTo, endSec);
    if (to <= from) continue;
    const prev = i > 0 ? `{\\fs${PREV_SIZE}\\alpha${PREV_ALPHA}}${renderChunk(chunks[i - 1])}{\\r}\\N` : '';
    const size = isAccent(chunks[i]) ? `\\fs${ACCENT_SIZE}` : '';
    const body = `{${size}\\alpha&HFF&\\t(0,${FADE_IN_MS},\\alpha&H00&)}${renderChunk(chunks[i])}`;
    events.push({ from, to, text: `${prev}${body}` });
  }
  return events;
}

// Alignment 8 — верх по центру, MarginV 250. Текст лишається ВГОРІ, хоч у
// зразку власника він стояв нижче центру: у наших кадрах головний об'єкт
// малюється знизу або по центру (це вимога промту генерації фото — «верхні
// 40 % кадру візуально спокійні»), тож напис унизу перекривав би сам сюжет.
const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Oswald,104,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,1,0,1,6,0,8,120,120,250,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

// Будує повний ASS для відео. lines — по рядку на слайд; durations — тривалості
// слайдів (с), ті самі, що й у монтажі. Текст слайда живе від його початку до
// старту кросфейду на наступний (щоб два слайди не накладались текстами).
export function buildAss(lines, durations) {
  const offsets = slideOffsets(durations);
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const start = offsets[i];
    const isLast = i === lines.length - 1;
    const end = isLast ? offsets[i] + durations[i] : offsets[i + 1];
    const windowSec = Math.max(0.8, durations[i] - FADE_SECONDS - PAD_APPROX);
    for (const ev of slideEvents(lines[i], start, end, windowSec)) {
      events.push(`Dialogue: 0,${assTime(ev.from)},${assTime(ev.to)},Cap,,0,0,0,,${ev.text}`);
    }
  }
  return HEADER + events.join('\n') + '\n';
}

// Експорт для тестів.
export { atomize };
