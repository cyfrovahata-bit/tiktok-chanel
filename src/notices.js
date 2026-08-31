// Пам'ять про вже надіслані сповіщення.
//
// Конвеєр тепер веде ChatGPT двома відкладеними завданнями (08:00 — тема й
// сюжет, 15:00 — фото й архів), а бот лише спостерігає за таблицею і
// розповідає власнику, що відбувається. Щоб не слати те саме повідомлення на
// кожному проході — і щоб перезапуск Railway не починав усе спочатку —
// останній оголошений статус кожного рядка лежить файлом на Drive.
import { drive } from './drive.js';
import { promptFolderId } from './kyiv.js';

const FILE_NAME = 'notices.json';
// Запобіжник від нескінченного росту файлу, а НЕ робоча межа.
//
// Раніше тут стояло 120, і це виявилося пасткою: таблиця переросла пам'ять
// (134 рядки проти 120), тож кожен прохід відрізав початок файлу. Забуті рядки
// наступного проходу поверталися в кінець, зсуваючи решту до початку, — і
// рано чи пізно під ніж потрапляв рядок зі статусом NEW. Тоді він вважався
// щойно побаченим, і «Тема на сьогодні» летіла власникові вкотре.
//
// Тепер зайве прибирає монітор (pruneNotices) — він знає, які рядки ще є в
// таблиці. Тут лишається стеля, до якої в нормальній роботі не доходить.
const KEEP = 5000;

async function findFile() {
  const res = await drive().files.list({
    q: `'${promptFolderId()}' in parents and name = '${FILE_NAME}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

// { "AUTO-…": "NEW" } — який статус рядка вже оголошено власнику.
export async function readNotices() {
  const id = await findFile();
  if (!id) return {};
  try {
    const res = await drive().files.get({ fileId: id, alt: 'media', supportsAllDrives: true });
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return data && typeof data.seen === 'object' ? data.seen : {};
  } catch {
    return {}; // побитий файл не має ламати конвеєр — просто оголосимо ще раз
  }
}

export async function writeNotices(seen) {
  // Лишаємо лише хвіст: таблиця росте, а нам цікаві тільки свіжі рядки.
  const entries = Object.entries(seen).slice(-KEEP);
  const media = { mimeType: 'application/json', body: JSON.stringify({ seen: Object.fromEntries(entries) }, null, 2) };
  const existing = await findFile();
  if (existing) await drive().files.update({ fileId: existing, media, supportsAllDrives: true });
  else {
    await drive().files.create({
      requestBody: { name: FILE_NAME, parents: [promptFolderId()] },
      media, fields: 'id', supportsAllDrives: true,
    });
  }
}

// Забути рядок (після видалення з таблиці), щоб він не «висів» у пам'яті
// оголошених статусів і не заважав, якщо той самий ID колись повториться.
export async function forgetNotice(id) {
  const seen = await readNotices();
  if (!(id in seen)) return false;
  delete seen[id];
  await writeNotices(seen);
  return true;
}
