// Папка «video» на Google Drive — сховище готових роликів. Драйв тут не лише
// сховище: наявність файла <ID>.mp4 = ознака «відео вже змонтоване», тож
// додаток на Railway лишається без стану (жодного Volume/леджера).
//
// Сервіс-акаунту треба розшарити цю папку на «Редактор» (щоб вивантажувати).
import { createReadStream } from 'node:fs';
import { drive } from './drive.js';

const FOLDER_ID = process.env.VIDEO_FOLDER_ID || '';

export function videoFolderId() {
  return FOLDER_ID;
}

export function videoName(id) {
  return `${String(id).replace(/[^A-Za-z0-9_.-]/g, '_')}.mp4`;
}

// Мапа {ім'я файлу → fileId} всіх відео в папці. Порожня, якщо папку не задано.
export async function listVideos() {
  if (!FOLDER_ID) return new Map();
  const map = new Map();
  let pageToken;
  do {
    const res = await drive().files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files || []) map.set(f.name, f.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return map;
}

// Вивантажує локальне відео у папку як <ID>.mp4. Повертає fileId.
export async function uploadVideo(id, localPath) {
  if (!FOLDER_ID) throw new Error('Не задано VIDEO_FOLDER_ID — нема куди вивантажувати відео');
  const res = await drive().files.create({
    requestBody: { name: videoName(id), parents: [FOLDER_ID] },
    media: { mimeType: 'video/mp4', body: createReadStream(localPath) },
    fields: 'id',
    supportsAllDrives: true,
  });
  return res.data.id;
}

// Стрім відео з Drive (з опційним Range для перемотки у прев'ю).
// Повертає { stream, status, headers } — сервер перекладає це у відповідь.
export async function streamVideo(fileId, range) {
  const options = { responseType: 'stream' };
  if (range) options.headers = { Range: range };
  const res = await drive().files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    options,
  );
  return { stream: res.data, status: res.status, headers: res.headers };
}
