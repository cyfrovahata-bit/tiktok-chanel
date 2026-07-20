// Монітор черги тем. Головний критерій готовності — статус DONE у Google
// Sheet (не час). Драйв тримає готові відео (папка «video»), і НАЯВНІСТЬ
// файла <ID>.mp4 там = «вже змонтовано». Тому додаток без стану: Volume і
// леджер не потрібні — джерело правди Sheet + Drive.
//
// Цикл:
//   1. читає таблицю, бере готові DONE;
//   2. якщо відео вже в Drive — пропускає (дедуп через існування файла);
//   3. інакше: шле «знайшов тему», качає ZIP, монтує, вивантажує у Drive,
//      шле «відео готове» з кнопкою мінідодатку.
// PROCESSING/ERROR не чіпаємо. Лічильник спроб — у пам'яті процесу (після
// перезапуску просто спробуємо знову, це безпечно).
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDoneItems } from './sheets.js';
import { downloadArchive } from './drive.js';
import { listVideos, uploadVideo, videoName, videoFolderId } from './videos.js';
import { extractPhotoArchive } from './archive.js';
import { assembleVideo } from './pipeline.js';
import { sendMessage, ownerChatId } from './telegram.js';

const POLL_MS = Number(process.env.POLL_INTERVAL_MS) || 5 * 60 * 1000; // 5 хв
const MAX_ATTEMPTS = 3;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tiktok-chanel-production.up.railway.app').replace(/\/$/, '');

// Спроби на кожен ID у межах життя процесу (щоб не спамити «знайшов тему»
// на кожній ітерації, коли монтаж падає, і зупинитись після MAX_ATTEMPTS).
const attempts = new Map();

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

// Монтує відео для одного матеріалу й вивантажує його у Drive.
async function processItem(item) {
  const tried = attempts.get(item.id) || 0;
  // «Знайшов тему» — лише на першій спробі (як у прикладі: «Архів знайдено»).
  if (tried === 0) {
    await notify(`🔎 Знайшов нову тему:\n${item.title}\n\nАрхів знайдено — генерую відео…`);
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'monitor-'));
  const zipPath = path.join(workDir, 'archive.zip');
  await downloadArchive(item.archive, zipPath);
  const zipBuffer = await readFile(zipPath);
  const { photoPaths, scriptText } = await extractPhotoArchive(zipBuffer);

  // Назву/опис беремо з таблиці — тут потрібне лише відео (без OpenAI-текстів).
  const { videoPath } = await assembleVideo({
    photoPaths,
    theme: item.theme,
    script: scriptText,
    withTexts: false,
  });

  await uploadVideo(item.id, videoPath);
  attempts.delete(item.id); // успіх — забуваємо лічильник

  await notify(
    `🎬 Відео згенеровано:\n${item.title}\n\nВідкрий мінідодаток, щоб переглянути, скопіювати опис і опублікувати.`,
    openAppMarkup(item.id),
  );
}

// Один прохід черги.
export async function pollOnce() {
  if (!videoFolderId()) {
    console.warn('[monitor] VIDEO_FOLDER_ID не задано — пропускаю прохід (нема куди класти відео).');
    return 0;
  }
  const [items, videos] = await Promise.all([listDoneItems(), listVideos()]);
  let generated = 0;
  for (const item of items) {
    if (videos.has(videoName(item.id))) continue; // відео вже є → готове
    if ((attempts.get(item.id) || 0) >= MAX_ATTEMPTS) continue; // здалися
    try {
      await processItem(item);
      generated++;
    } catch (error) {
      const tried = (attempts.get(item.id) || 0) + 1;
      attempts.set(item.id, tried);
      console.error(`Помилка обробки ${item.id} (спроба ${tried}):`, error.message);
      if (tried >= MAX_ATTEMPTS) {
        await notify(`⚠️ Не вдалося зробити відео для «${item.title}» після ${MAX_ATTEMPTS} спроб:\n${error.message}`);
      }
    }
  }
  return items.length;
}

// Нескінченний цикл моніторингу для процесу на Railway.
export function startMonitor() {
  let running = false;
  const tick = async () => {
    if (running) return;
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
  tick();
  return setInterval(tick, POLL_MS);
}
