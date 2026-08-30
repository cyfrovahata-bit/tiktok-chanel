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
//   youtube — горизонталь 16:9, обкладинка для YouTube; у відео не потрапляє
//             взагалі, її ставить заливка окремим викликом.
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
export const THUMB_MAX_BYTES = 2 * 1024 * 1024;
const THUMB_QUALITY = [3, 5, 7, 10, 15];

export async function normalizeThumbnail(srcPath, destPath) {
  let last = null;
  for (const q of THUMB_QUALITY) {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', srcPath,
      '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720',
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
