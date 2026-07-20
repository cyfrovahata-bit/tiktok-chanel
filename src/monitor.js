// Монітор черги тем. Головний критерій готовності — статус DONE у Google
// Sheet (не час). Цикл:
//   1. читає таблицю, знаходить готові DONE, ще не оброблені;
//   2. шле Telegram «знайшов тему»;
//   3. качає ZIP з Drive, монтує відео (спільне ядро pipeline.js);
//   4. кешує відео у Volume, шле Telegram «відео готове» з кнопкою мінідодатку;
//   5. дедуп — через леджер (один ID обробляється один раз).
// PROCESSING/ERROR не чіпаємо: просто перевіримо пізніше.
import { mkdtemp, copyFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDoneItems } from './sheets.js';
import { downloadArchive } from './drive.js';
import { extractPhotoArchive } from './archive.js';
import { assembleVideo } from './pipeline.js';
import { readLedger, writeLedger, videoPathFor } from './storage.js';
import { sendMessage, ownerChatId } from './telegram.js';

const POLL_MS = Number(process.env.POLL_INTERVAL_MS) || 5 * 60 * 1000; // 5 хв
const MAX_ATTEMPTS = 3; // після стількох невдалих монтажів — не мучимо ID
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tiktok-chanel-production.up.railway.app').replace(/\/$/, '');

// Кнопка, що відкриває мінідодаток усередині Telegram на потрібному матеріалі.
function openAppMarkup(id) {
  return {
    inline_keyboard: [[
      { text: '📲 Відкрити й опублікувати', web_app: { url: `${PUBLIC_URL}/?id=${encodeURIComponent(id)}` } },
    ]],
  };
}

async function notify(text, markup) {
  try {
    await sendMessage(ownerChatId(), text, markup);
  } catch (error) {
    console.error('Не вдалося надіслати сповіщення:', error.message);
  }
}

// Обробляє один готовий матеріал: монтує відео й повідомляє власника.
async function processItem(item, ledger) {
  const entry = ledger[item.id] || { attempts: 0 };
  entry.title = item.title;
  entry.theme = item.theme;
  entry.description = item.description;

  // Перше знайдення — повідомляємо (як у прикладі: «тема … Архів знайдено»).
  if (!entry.foundAt) {
    entry.foundAt = new Date().toISOString();
    entry.status = 'found';
    ledger[item.id] = entry;
    await writeLedger(ledger);
    await notify(`🔎 Знайшов нову тему:\n${item.title}\n\nАрхів знайдено — генерую відео…`);
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'monitor-'));
  const zipPath = path.join(workDir, 'archive.zip');
  await downloadArchive(item.archive, zipPath);
  const zipBuffer = await readFile(zipPath);
  const { photoPaths, scriptText } = await extractPhotoArchive(zipBuffer);

  // Назва/опис беруться з таблиці (не генеруємо) — тут потрібне лише відео.
  const { videoPath } = await assembleVideo({
    photoPaths,
    theme: item.theme,
    script: scriptText,
    withTexts: false, // назву/опис беремо з таблиці, не генеруємо
  });

  const dest = videoPathFor(item.id);
  await copyFile(videoPath, dest);

  entry.videoFile = path.basename(dest);
  entry.readyAt = new Date().toISOString();
  entry.status = 'ready';
  ledger[item.id] = entry;
  await writeLedger(ledger);

  await notify(
    `🎬 Відео згенеровано:\n${item.title}\n\nВідкрий мінідодаток, щоб переглянути, скопіювати опис і опублікувати.`,
    openAppMarkup(item.id),
  );
}

// Один прохід черги.
export async function pollOnce() {
  const items = await listDoneItems();
  const ledger = await readLedger();
  for (const item of items) {
    const entry = ledger[item.id];
    // Уже готове/опубліковане — пропускаємо (дедуп).
    if (entry && (entry.status === 'ready' || entry.status === 'published')) continue;
    if (entry && entry.attempts >= MAX_ATTEMPTS) continue; // здалися після невдач
    try {
      await processItem(item, ledger);
    } catch (error) {
      console.error(`Помилка обробки ${item.id}:`, error.message);
      const e = ledger[item.id] || {};
      e.attempts = (e.attempts || 0) + 1;
      e.status = 'error';
      e.lastError = error.message;
      ledger[item.id] = e;
      await writeLedger(ledger);
      if (e.attempts >= MAX_ATTEMPTS) {
        await notify(`⚠️ Не вдалося зробити відео для «${item.title}» після ${MAX_ATTEMPTS} спроб:\n${error.message}`);
      }
    }
  }
  return items.length;
}

// Нескінченний цикл моніторингу (для процесу на Railway).
export function startMonitor() {
  let running = false;
  const tick = async () => {
    if (running) return; // не накладати проходи один на одного
    running = true;
    try {
      const n = await pollOnce();
      console.log(`[monitor] перевірено чергу: ${n} готових DONE у таблиці`);
    } catch (error) {
      console.error('[monitor] цикл упав:', error.message);
    } finally {
      running = false;
    }
  };
  console.log(`[monitor] старт, інтервал ${Math.round(POLL_MS / 1000)} с`);
  tick(); // одразу перший прохід
  return setInterval(tick, POLL_MS);
}
