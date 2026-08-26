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
import { drive } from './drive.js';

const NAME = 'compilation-preview.jpg';
const MAX_BYTES = 12 * 1024 * 1024;

function folderId() {
  const id = process.env.PREVIEW_FOLDER_ID || process.env.VIDEO_FOLDER_ID || '';
  if (!id) throw new Error('Не задано VIDEO_FOLDER_ID — нема де тримати прев\'ю');
  return id;
}

async function findFile() {
  const res = await drive().files.list({
    q: `'${folderId()}' in parents and name = '${NAME}' and trashed = false`,
    fields: 'files(id, name, size, modifiedTime)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0] || null;
}

// Скільки важить і коли оновлено — щоб мінідодаток показав, чи прев'ю взагалі є.
export async function previewInfo() {
  const file = await findFile().catch(() => null);
  if (!file) return { exists: false };
  return {
    exists: true,
    bytes: Number(file.size) || 0,
    updatedAt: file.modifiedTime || null,
  };
}

// data — base64 (з префіксом data: або без нього), як його шле мінідодаток.
export async function savePreview({ data, mimeType } = {}) {
  const buffer = Buffer.from(String(data || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buffer.length) throw new Error('Порожній файл');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`Прев'ю завелике (${Math.round(buffer.length / 1e6)} МБ, ліміт ${MAX_BYTES / 1e6} МБ)`);
  }
  const media = { mimeType: mimeType || 'image/jpeg', body: Readable.from(buffer) };
  const existing = await findFile();
  const res = existing
    ? await drive().files.update({ fileId: existing.id, media, fields: 'id, modifiedTime', supportsAllDrives: true })
    : await drive().files.create({
      requestBody: { name: NAME, parents: [folderId()] },
      media,
      fields: 'id, modifiedTime',
      supportsAllDrives: true,
    });
  return { fileId: res.data.id, bytes: buffer.length, updatedAt: res.data.modifiedTime || null };
}

// Кладе прев'ю у destPath. Повертає шлях або null, якщо прев'ю немає —
// відсутнє прев'ю не помилка, вступ просто лишиться на чорному тлі.
export async function fetchPreview(destPath) {
  const file = await findFile().catch(() => null);
  if (!file) return null;
  const res = await drive().files.get(
    { fileId: file.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  await pipeline(res.data, createWriteStream(destPath));
  return destPath;
}

export async function removePreview() {
  const file = await findFile();
  if (!file) return false;
  await drive().files.delete({ fileId: file.id, supportsAllDrives: true });
  return true;
}
