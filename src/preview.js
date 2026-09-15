// Прев'ю довгої добірки — картинка, яку власник малює в ChatGPT і вивантажує
// з мінідодатка. Вона стає ФОНОМ вступної заставки: замість чорного кадру
// глядач бачить обкладинку, а поверх неї лягають ті самі написи бандленим
// Oswald.
//
// Навмисно не малюємо текст самою картинкою: генератори зображень кирилицю
// псують (літери «пливуть», наголоси зникають), а субтитри ASS дають рівно
// той текст, що треба, і в тому ж шрифті, що й у роликах.
//
// Лежить прев'ю на Drive під сталим іменем: контейнер Railway без стану, і
// файл, покладений у теку процесу, зникав би на першому ж передеплої. Ім'я
// стале — нове вивантаження ЗАМІНЮЄ старе, а не плодить копії.
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { drive } from './drive.js';

const run = promisify(execFile);

// Два різні файли, і плутати їх не можна:
//   video   — вертикаль 9:16, стає першим кадром самої добірки (він же те, що
//             видно у стрічці Facebook);
//   youtube — обкладинка для YouTube; у відео не потрапляє взагалі, її ставить
//             заливка окремим викликом. Малюється як портрет 4:5, а на
//             16:9-полотно її кладе вже код — чому саме так, розписано над
//             normalizeThumbnail.
const NAMES = {
  video: 'compilation-preview.jpg',
  youtube: 'compilation-thumb.jpg',
};
export const PREVIEW_KINDS = Object.keys(NAMES);
const MAX_BYTES = 12 * 1024 * 1024;

function nameFor(kind) {
  const name = NAMES[String(kind || 'video')];
  if (!name) throw new Error(`Невідомий вид прев'ю: ${kind}`);
  return name;
}

function folderId() {
  const id = process.env.PREVIEW_FOLDER_ID || process.env.VIDEO_FOLDER_ID || '';
  if (!id) throw new Error('Не задано VIDEO_FOLDER_ID — нема де тримати прев\'ю');
  return id;
}

async function findFile(kind) {
  const res = await drive().files.list({
    q: `'${folderId()}' in parents and name = '${nameFor(kind)}' and trashed = false`,
    fields: 'files(id, name, size, mimeType, modifiedTime)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0] || null;
}

// Скільки важить і коли оновлено — щоб мінідодаток показав, чи прев'ю взагалі є.
export async function previewInfo(kind = 'video') {
  const file = await findFile(kind).catch(() => null);
  if (!file) return { kind, exists: false };
  return {
    kind,
    exists: true,
    bytes: Number(file.size) || 0,
    mimeType: file.mimeType || null,
    updatedAt: file.modifiedTime || null,
  };
}

// Стан обох файлів одним запитом — саме це показує мінідодаток.
export async function previewState() {
  const entries = await Promise.all(PREVIEW_KINDS.map((kind) => previewInfo(kind)));
  return Object.fromEntries(entries.map((info) => [info.kind, info]));
}

// data — base64 (з префіксом data: або без нього), як його шле мінідодаток.
export async function savePreview({ kind = 'video', data, mimeType } = {}) {
  const buffer = Buffer.from(String(data || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buffer.length) throw new Error('Порожній файл');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`Прев'ю завелике (${Math.round(buffer.length / 1e6)} МБ, ліміт ${MAX_BYTES / 1e6} МБ)`);
  }
  const media = { mimeType: mimeType || 'image/jpeg', body: Readable.from(buffer) };
  const existing = await findFile(kind);
  const res = existing
    ? await drive().files.update({ fileId: existing.id, media, fields: 'id, modifiedTime', supportsAllDrives: true })
    : await drive().files.create({
      requestBody: { name: nameFor(kind), parents: [folderId()] },
      media,
      fields: 'id, modifiedTime',
      supportsAllDrives: true,
    });
  return { kind, fileId: res.data.id, bytes: buffer.length, updatedAt: res.data.modifiedTime || null };
}

// Кладе прев'ю у destPath. Повертає шлях або null, якщо прев'ю немає —
// відсутнє прев'ю не помилка, вступ просто лишиться на чорному тлі.
export async function fetchPreview(destPath, kind = 'video') {
  const file = await findFile(kind).catch(() => null);
  if (!file) return null;
  const res = await drive().files.get(
    { fileId: file.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  await pipeline(res.data, createWriteStream(destPath));
  return destPath;
}

// YouTube приймає обкладинку не будь-яку: рівно JPEG або PNG і не більше двох
// мегабайтів. Перша ж заливка добірки на це й наштрикнулася — «The provided
// image content is invalid»: ChatGPT віддає PNG, мінідодаток кладе його на
// Drive як є (ім'я .jpg нічого не змінює), а заливка каже, що це JPEG.
//
// Тому перед заливкою картинку завжди переганяємо: 1280×720, JPEG, і тиснемо,
// доки не влізе в ліміт. Це дешевше за будь-яку перевірку типів — на виході
// гарантовано те, що YouTube візьме.
//
// ЧОМУ 16:9, ХОЧ ДОБІРКА ВЕРТИКАЛЬНА. Вертикальну обкладинку поставити
// НЕМОЖЛИВО: YouTube зберігає будь-яку завантажену картинку як 16:9. Заливка
// 1080×1920 повернулася назад обрізаною до 16:9 — це видно в самому CDN:
// i.ytimg.com/.../sddefault.jpg приходить 640×480, де сам кадр рівно 640×360,
// а зверху й знизу чорні смуги. Тобто вертикаль ми віддавали, а він однаково
// різав її до горизонталі, ще й втрачаючи верх і низ.
//
// ЩО РІЖЕ ДРУГИЙ РАЗ. Оскільки відео вертикальне, у стрічці на телефоні
// YouTube малює йому картку 4:5 (виміряно на скріні: 1080×1342, це 0,805) і
// накриває її 16:9-обкладинкою «на заповнення». Видно тільки центральні
// 1080/(1342·16/9) ≈ 45% ширини — 580 пікселів із 1280.
//
// ЗВІДСИ РІШЕННЯ. Художник малює ПОРТРЕТ 4:5, а боки до 16:9 домальовує код:
// розмитою копією того самого кадру. Портрет заввишки 720 — це 576 пікселів
// завширшки, тобто рівно та центральна смуга, яка виживає. У стрічці глядач
// бачить плакат цілим, на комп'ютері — той самий плакат із м'якими боками.
// Це надійніше за вказівку «тримай напис у центрі»: її генератор ігнорував —
// на «ЗАБУТІ СКАРБИ» напис зайняв 67% ширини замість дозволених 45%.
export const THUMB_MAX_BYTES = 2 * 1024 * 1024;
const THUMB_QUALITY = [3, 5, 7, 10, 15];
const THUMB_W = 1280;
const THUMB_H = 720;

// Розміри картинки, яку віддав генератор. Без них не відрізнити портрет від
// горизонталі, а це вирішує, доповнювати боки чи обрізати.
async function imageSize(srcPath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', srcPath]);
  const [w, h] = stdout.trim().split(',').map(Number);
  if (!(w > 0 && h > 0)) throw new Error(`Не вдалося прочитати розмір картинки: ${stdout.trim()}`);
  return { width: w, height: h };
}

// Портрет і квадрат кладемо на 16:9 цілими, домальовуючи боки розмитою копією;
// горизонталь просто кадруємо, як робили завжди. Межа саме 16:9: усе, що
// вужче, у кроп не влізло б без втрати верху й низу — а там і стоїть напис.
export function thumbnailFilter({ width, height }) {
  const wide = width / height >= THUMB_W / THUMB_H;
  if (wide) {
    return `scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,`
      + `crop=${THUMB_W}:${THUMB_H}`;
  }
  return `[0:v]scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,`
    + `crop=${THUMB_W}:${THUMB_H},boxblur=40:5[bg];`
    + `[0:v]scale=-2:${THUMB_H}[fg];[bg][fg]overlay=(W-w)/2:0`;
}

export async function normalizeThumbnail(srcPath, destPath) {
  const size = await imageSize(srcPath);
  const filter = thumbnailFilter(size);
  // filter_complex і vf — різні прапорці, а склейка боків можлива лише першим.
  const flag = filter.startsWith('[') ? '-filter_complex' : '-vf';
  let last = null;
  for (const q of THUMB_QUALITY) {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', srcPath,
      flag, filter,
      '-q:v', String(q), '-f', 'mjpeg', destPath]);
    last = (await stat(destPath)).size;
    if (last <= THUMB_MAX_BYTES) return { path: destPath, bytes: last, quality: q };
  }
  // Навіть на найгіршій якості не влізло — віддаємо як є: хай краще заливка
  // скаже правду про відмову, ніж ми мовчки не поставимо обкладинку.
  return { path: destPath, bytes: last, quality: THUMB_QUALITY.at(-1) };
}

export async function removePreview(kind = 'video') {
  const file = await findFile(kind);
  if (!file) return false;
  await drive().files.delete({ fileId: file.id, supportsAllDrives: true });
  return true;
}
