// Голосовий банк: короткі репліки, які в кожній добірці однакові — вступ
// («У цьому відео 15 фактів про Україну. Почнімо.») і оголошення перед кожним
// сюжетом («Факт перший»). Текст у них не змінюється ніколи, тож синтезувати
// їх на кожну збірку немає сенсу: звучали б вони так само, але щоразу палили б
// символи ElevenLabs і додавали хвилини до збірки.
//
// Тому кожна репліка синтезується РАЗ, а далі просто підставляється. Шукаємо її
// в трьох місцях по черзі:
//   1) assets/voice/<ключ>.mp3 — покладене в репозиторій: переживає передеплой,
//      не потребує ані ключів TTS, ані Drive;
//   2) папка на Drive — туди лягає все, що довелося синтезувати вже на живому
//      Railway (контейнер без стану, тека з ним і зникає);
//   3) синтез — лише якщо репліки немає ніде. Результат одразу лягає і в теку,
//      і на Drive, тож наступна збірка його вже не синтезує.
//
// Прогнати весь банк наперед і покласти в репозиторій:
//   node scripts/build-voice-bank.js 20
import os from 'node:os';
import path from 'node:path';
import { access, copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ordinalUkrainian } from './num2words-uk.js';

// Тека банку. Стандартно — та, що в репозиторії; VOICE_BANK_DIR потрібен, якщо
// на Railway колись з'явиться Volume і банк захочеться тримати там.
const REPO_DIR = fileURLToPath(new URL('../assets/voice', import.meta.url));
export function bankDir() {
  return process.env.VOICE_BANK_DIR || REPO_DIR;
}

// На Drive банк лежить у тій самій папці, що й відео (окрема потрібна рідко —
// тоді VOICE_FOLDER_ID). Префікс у назві потрібен, щоб репліки не плутались із
// роликами: монітор шукає рівно «<ID>.mp4», а тут «voice-fact-03.mp3».
const DRIVE_PREFIX = 'voice-';
function folderId() {
  return process.env.VOICE_FOLDER_ID || process.env.VIDEO_FOLDER_ID || '';
}

// --- Тексти реплік -----------------------------------------------------------
// Чисті функції: саме вони визначають, ЩО озвучено, тож їх перевіряють тести.

// «1 факт», «2 факти», «5 фактів» — і окремо 11–14, які попри одиницю на кінці
// беруть форму множини («11 фактів», не «11 факт»).
export function factWordForm(count) {
  const n = Math.abs(Math.trunc(Number(count) || 0));
  const teen = n % 100;
  if (teen >= 11 && teen <= 14) return 'фактів';
  const last = n % 10;
  if (last === 1) return 'факт';
  if (last >= 2 && last <= 4) return 'факти';
  return 'фактів';
}

// Написи на вступній заставці. Питання зверху, число великим, уточнення внизу:
//
//        ЧИ ЗНАВ ТИ ТАКУ УКРАЇНУ?
//              15 ФАКТІВ
//        ЯКИХ ТИ, МОЖЛИВО, НЕ ЗНАВ
export const INTRO_QUESTION = 'ЧИ ЗНАВ ТИ ТАКУ УКРАЇНУ?';
export const INTRO_TAGLINE = 'ЯКИХ ТИ, МОЖЛИВО, НЕ ЗНАВ';

export function introTitle(count) {
  return `${count} ${factWordForm(count).toUpperCase()}`;
}

// «1 історія», «2 історії», «5 історій».
export function storyWordForm(count) {
  const n = Math.abs(Math.trunc(Number(count) || 0));
  const teen = n % 100;
  if (teen >= 11 && teen <= 14) return 'історій';
  const last = n % 10;
  if (last === 1) return 'історія';
  if (last >= 2 && last <= 4) return 'історії';
  return 'історій';
}

// Що диктор каже на вступі. Число лишаємо цифрами: перед синтезом tts.js сам
// розгортає його в слово з правильним наголосом.
//
// Спроба писати вступ моделлю під кожну добірку провалилася: замість гачка
// виходив то анонс одного об'єкта з п'яти, то запитання, на яке легко
// відповісти «ні», то порожня обіцянка «далі покажемо ще більше». Власник
// попросив просту загадкову фразу — і має рацію: заставка й так показує назву
// добірки, вступ мусить лише пообіцяти кількість і настрій.
//
// Варіанти чергуються, щоб добірки не зливалися в одну. Кожен синтезується
// РАЗ на кількість фактів і далі береться з банку — жодних витрат на ElevenLabs
// і жодної затримки в монтажі.
export const INTRO_VARIANTS = [
  (n, w) => `Чи знав ти таку Україну? ${n} ${w}, яких ти, можливо, не чув.`,
  (n, w) => `Україна, якої ти не знав. ${n} ${w} в одному відео.`,
  (n, w) => `${n} ${w} про Україну, яких немає в підручниках.`,
  (n, w) => `Україна зблизька. ${n} ${w}, у які важко повірити.`,
  (n, w) => `${n} ${w} про Україну — і кожну легко проґавити.`,
];

export function introLine(count, variant = 0) {
  const n = Math.trunc(Number(count) || 0);
  const at = ((Math.trunc(Number(variant) || 0) % INTRO_VARIANTS.length) + INTRO_VARIANTS.length)
    % INTRO_VARIANTS.length;
  return INTRO_VARIANTS[at](n, storyWordForm(n));
}

// Оголошення перед сюжетом. Без назви — «Факт третій»; із назвою —
// «Факт третій. Хотинська фортеця». Друге звучить помітно краще: глядач одразу
// чує, про що буде, а не лише порядковий номер. Платимо за це синтезом на
// кожну нову пару «номер + назва», але репліки короткі, і ключ із хешем
// сам перевикористає ту, що вже є.
export function factLine(number, label = '') {
  const base = `Факт ${ordinalUkrainian(number, 'ий')}.`;
  const name = String(label || '').trim().replace(/[.!?…]+$/, '');
  return name ? `${base} ${name}.` : base;
}

// Напис на картці оголошення: «ФАКТ 3».
export function factTitle(number) {
  return `ФАКТ ${number}`;
}

// Ключ несе хвіст із хеша САМОГО ТЕКСТУ. Без нього виправлення репліки
// («Почнімо» → «Чи знав ти таку Україну?») лишалося б непочутим: у теці вже
// лежав би mp3 під тим самим ключем, і збірка далі підставляла б старий голос.
// З хешем змінений текст автоматично стає новою реплікою.
function textHash(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 6);
}

export function introKey(count, spoken = null) {
  const n = Math.trunc(count);
  return `intro-${n}-${textHash(spoken || introLine(n))}`;
}

export function factKey(number, label = '') {
  const n = Math.trunc(number);
  return `fact-${String(n).padStart(2, '0')}-${textHash(factLine(n, label))}`;
}

// Повний список реплік банку — для разової генерації наперед.
//
// Вступів тепер більше, ніж було: кожен варіант фрази на кожен розмір
// добірки. Зате всі вони відомі наперед, тож монтаж жодного разу не чекає
// на синтез. facts потрібні лише з ANNOUNCE_VOICE=1 — між фактами диктор
// мовчить, — тож наперед їх не женемо.
export function bankPlan({ maxFacts = 20, minFacts = 2, facts = false } = {}) {
  const plan = [];
  for (let n = minFacts; n <= maxFacts; n++) {
    INTRO_VARIANTS.forEach((_, variant) => {
      const text = introLine(n, variant);
      plan.push({ key: introKey(n, text), text });
    });
  }
  if (facts) {
    for (let n = 1; n <= maxFacts; n++) plan.push({ key: factKey(n), text: factLine(n) });
  }
  return plan;
}

// --- Сховище -----------------------------------------------------------------

function safeKey(key) {
  const clean = String(key).replace(/[^A-Za-z0-9_-]/g, '-');
  if (!clean) throw new Error('Порожній ключ репліки');
  return clean;
}

export function clipPath(key) {
  return path.join(bankDir(), `${safeKey(key)}.mp3`);
}

export function driveName(key) {
  return `${DRIVE_PREFIX}${safeKey(key)}.mp3`;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function shortError(error) {
  return String(error?.message || error).split('\n')[0];
}

// Drive підвантажуємо динамічно: без цього кожен імпорт банку тягнув би за
// собою googleapis, а більшість викликів обходиться готовим файлом із теки.
async function driveApi() {
  const { drive } = await import('./drive.js');
  return drive();
}

async function findOnDrive(name) {
  const parent = folderId();
  if (!parent) return null;
  const api = await driveApi();
  const res = await api.files.list({
    q: `'${parent}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id || null;
}

async function downloadFromDrive(fileId, destPath) {
  const api = await driveApi();
  const res = await api.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  // Пишемо через .part: обірваний посеред запису mp3 інакше лишився б у теці й
  // назавжди вважався б готовою реплікою.
  await pipeline(res.data, createWriteStream(`${destPath}.part`));
  await rename(`${destPath}.part`, destPath);
  return destPath;
}

export async function uploadToDrive(key, localPath) {
  const parent = folderId();
  if (!parent) return null;
  const api = await driveApi();
  const res = await api.files.create({
    requestBody: { name: driveName(key), parents: [parent] },
    media: { mimeType: 'audio/mpeg', body: createReadStream(localPath) },
    fields: 'id',
    supportsAllDrives: true,
  });
  return res.data.id;
}

async function synthesizeToFile(text, destPath) {
  const { synthesizeVoiceover } = await import('./tts.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voicebank-'));
  const out = path.join(dir, 'clip.mp3');
  try {
    // Той самий шлях, що й для реплік у роликах: один рядок — одна репліка,
    // із обрізаною тишею по краях.
    await synthesizeVoiceover(text, out, 4, 1, [text]);
    await copyFile(out, `${destPath}.part`);
    await rename(`${destPath}.part`, destPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return destPath;
}

// Головний вхід: шлях до mp3 із реплікою. Синтез трапляється щонайбільше раз
// на ключ за все життя каналу.
export async function voiceClip(key, text, { onProgress = () => {}, allowSynthesis = true } = {}) {
  const local = clipPath(key);
  if (await exists(local)) return local;
  await mkdir(path.dirname(local), { recursive: true });

  try {
    const fileId = await findOnDrive(driveName(key));
    if (fileId) {
      await downloadFromDrive(fileId, local);
      onProgress(`   голос «${key}» — з Drive`);
      return local;
    }
  } catch (error) {
    onProgress(`   Drive не віддав голос «${key}»: ${shortError(error)}`);
  }

  if (!allowSynthesis) throw new Error(`Репліки «${key}» немає в банку`);
  onProgress(`   синтезую голос «${key}» — разово, далі братиму готовий`);
  await synthesizeToFile(text, local);
  try {
    const fileId = await uploadToDrive(key, local);
    if (fileId) onProgress(`   голос «${key}» збережено на Drive`);
  } catch (error) {
    onProgress(`   на Drive голос «${key}» не поклав: ${shortError(error)}`);
  }
  return local;
}

// Прибрати репліку з Drive. Потрібно лише скрипту з --force: інакше стара
// копія повернулася б із Drive замість щойно синтезованої.
export async function removeFromDrive(key) {
  const fileId = await findOnDrive(driveName(key));
  if (!fileId) return false;
  const api = await driveApi();
  await api.files.delete({ fileId, supportsAllDrives: true });
  return true;
}

// Чи є репліка вже готовою (для журналу й скрипта разової генерації).
export async function hasClip(key) {
  return exists(clipPath(key));
}
