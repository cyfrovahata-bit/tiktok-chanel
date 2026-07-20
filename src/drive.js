// Завантаження готового ZIP-архіву з Google Drive за посиланням із колонки
// «Архів». Той самий сервіс-акаунт (папку розшарено йому на «Перегляд»).
// Ми НЕ шукаємо файли в папці самі — беремо рівно те посилання, що в таблиці.
import { google } from 'googleapis';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { googleAuth } from './google-auth.js';

let driveApi = null;
function api() {
  if (!driveApi) driveApi = google.drive({ version: 'v3', auth: googleAuth() });
  return driveApi;
}

// Витягує fileId з будь-якого типового посилання Drive:
//   https://drive.google.com/file/d/<ID>/view?...   → <ID>
//   https://drive.google.com/open?id=<ID>           → <ID>
//   https://drive.google.com/uc?id=<ID>&export=...  → <ID>
//   або сам голий <ID>.
export function fileIdFromUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  const byPath = s.match(/\/d\/([A-Za-z0-9_-]{20,})/);
  if (byPath) return byPath[1];
  const byQuery = s.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (byQuery) return byQuery[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s; // вже голий ID
  return null;
}

// Завантажує ZIP у destPath. Повертає destPath.
export async function downloadArchive(archiveUrl, destPath) {
  const fileId = fileIdFromUrl(archiveUrl);
  if (!fileId) throw new Error(`Не вдалося розпізнати fileId у посиланні: ${archiveUrl}`);
  const res = await api().files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  await pipeline(res.data, createWriteStream(destPath));
  return destPath;
}
