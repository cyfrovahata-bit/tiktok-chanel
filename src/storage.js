// Сховище стану додатка на Railway. Контейнер ефемерний, тож леджер і готові
// відео кладемо у постійний том (Railway Volume), змонтований у DATA_DIR.
// Якщо тому немає (локальний запуск) — падаємо у тимчасову теку: працює,
// але кеш зникне при перезапуску.
import { mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || (existsSync('/data') ? '/data' : path.join(os.tmpdir(), 'tiktok-data'));
export const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const LEDGER_PATH = path.join(DATA_DIR, 'ledger.json');

mkdirSync(VIDEO_DIR, { recursive: true });

export function videoPathFor(id) {
  return path.join(VIDEO_DIR, `${sanitize(id)}.mp4`);
}

function sanitize(id) {
  return String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
}

// Леджер: { [id]: { status, title, theme, description, videoFile, foundAt,
//                    readyAt, attempts, remindedAt } }. status: found|ready|
// published|error.
export async function readLedger() {
  try {
    return JSON.parse(await readFile(LEDGER_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// Атомарний запис (через тимчасовий файл + rename), щоб перезапуск посеред
// запису не лишив пошкоджений JSON.
export async function writeLedger(ledger) {
  const tmp = `${LEDGER_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2));
  await rename(tmp, LEDGER_PATH);
}

export { DATA_DIR };
