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

export function autoPostMarkerName(id) {
  return `${videoName(id)}.autopost.json`;
}

// Мапа {ім'я файлу → { id, name, appProperties }}. appProperties зберігають
// технічний стан автопублікації; Google Sheet при цьому не змінюється.
export async function listVideoFiles() {
  if (!FOLDER_ID) return new Map();
  const map = new Map();
  let pageToken;
  do {
    const res = await drive().files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, appProperties)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files || []) {
      map.set(f.name, {
        id: f.id,
        name: f.name,
        appProperties: f.appProperties || {},
      });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return map;
}

// Зворотно сумісна мапа {ім'я файлу → fileId} для монітора й веб-прев'ю.
export async function listVideos() {
  const files = await listVideoFiles();
  return new Map([...files].map(([name, file]) => [name, file.id]));
}

// Дописує службові appProperties до відео. Значення не потрапляють у таблицю
// і переживають перезапуски Railway, тому захищають від повторного постингу.
export async function setVideoAppProperties(fileId, patch) {
  const current = await drive().files.get({
    fileId,
    fields: 'appProperties',
    supportsAllDrives: true,
  });
  const merged = { ...(current.data.appProperties || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value == null) delete merged[key];
    else merged[key] = String(value);
  }
  await drive().files.update({
    fileId,
    requestBody: { appProperties: merged },
    fields: 'id, appProperties',
    supportsAllDrives: true,
  });
  return merged;
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

// Видаляє відео <ID>.mp4 з папки (щоб монітор згенерував його наново новим
// кодом). Повертає true, якщо було що видаляти.
export async function deleteVideo(id) {
  const files = await listVideoFiles();
  const file = files.get(videoName(id));
  if (!file) return false;

  // Якщо Meta вже отримала це відео (повністю або частково), зберігаємо
  // службові мітки в маленькому marker-файлі. Інакше кнопка
  // «Перегенерувати» стерла б захист і могла б опублікувати Reel повторно.
  if (file.appProperties?.autoPostSlot) {
    const markerName = autoPostMarkerName(id);
    const marker = files.get(markerName);
    if (marker) {
      await setVideoAppProperties(marker.id, file.appProperties);
    } else {
      await drive().files.create({
        requestBody: {
          name: markerName,
          parents: [FOLDER_ID],
          mimeType: 'application/json',
          appProperties: file.appProperties,
        },
        fields: 'id',
        supportsAllDrives: true,
      });
    }
  }

  await drive().files.delete({ fileId: file.id, supportsAllDrives: true });
  return true;
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
