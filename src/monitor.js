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
import { listDoneItems, readAllItems } from './sheets.js';
import { downloadArchive } from './drive.js';
import { listDrafts, upsertDraft, kyivToday, currentSlot, listRejectedThemes, rejectDraft } from './drafts.js';
import { generateScenario } from './scenario.js';
import { listVideos, uploadVideo, videoName, videoFolderId } from './videos.js';
import { extractPhotoArchive } from './archive.js';
import { assembleVideo } from './pipeline.js';
import { sendMessage, ownerChatId } from './telegram.js';

// ChatGPT стартує о 08:00 і 16:00 (Київ). Часто перевіряємо Drive вже трохи
// до цих запусків і до часу автопублікації; поза вікнами — рідше.
const FAST_MS = Number(process.env.POLL_FAST_MS) || 2 * 60 * 1000;   // у вікні
const SLOW_MS = Number(process.env.POLL_SLOW_MS) || 15 * 60 * 1000;  // поза вікном
const MAX_ATTEMPTS = 3;

// Хвилини від початку доби за київським часом.
function kyivMinuteOfDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

// Активні вікна: 07:45–10:30 і 15:45–18:30. Стартуємо перевірку за 15 хв
// до генерації; після 10:00/18:00 лишаємо запас для затриманого архіву.
export function inActiveWindow(now = new Date()) {
  const m = kyivMinuteOfDay(now);
  return (m >= 7 * 60 + 45 && m <= 10 * 60 + 30) || (m >= 15 * 60 + 45 && m <= 18 * 60 + 30);
}
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

// Забути лічильник спроб для ID (напр. після ручної перегенерації).
export function forget(id) { attempts.delete(id); }

// --- Чернетки сценаріїв: ранкова (з 08:00) і вечірня (з 16:00) --------------
// Готуємо завчасно, щоб був час переглянути й перегенерувати до того, як
// ChatGPT за відкладеним завданням візьме рядок у роботу.
// force — примусово нова тема; slotOverride — для якого слота.
export async function ensureDailyDraft(force = false, slotOverride = null, silent = false) {
  const today = kyivToday();
  const slot = slotOverride || currentSlot();
  if (!slot) return null; // ще до 08:00 — нічого не готуємо
  const key = `${today}-${slot}`;
  const items = await listDrafts().catch(() => []);
  if (!force && items.some((d) => d.key === key)) return null; // на цей слот уже є

  // «Інша тема»: стару тему цього слота позначаємо відхиленою, щоб генератор
  // більше ніколи її не пропонував.
  if (force && items.some((d) => d.key === key)) {
    await rejectDraft(key).catch((e) => console.error('[draft] відхилення:', e.message));
  }

  const [used, rejected] = await Promise.all([
    readAllItems().catch(() => []),
    listRejectedThemes().catch(() => []),
  ]);
  // Заборонені теми = рядки таблиці + наявні чернетки (зокрема сусіднього
  // слота, інакше ранок і вечір вигадають те саме) + усі відхилені власником.
  const usedTitles = [
    ...used.map((it) => it.theme),
    ...items.filter((d) => d.key !== key).map((d) => d.theme),
    ...rejected,
  ].filter(Boolean);
  const scenario = await generateScenario(usedTitles);
  const draft = {
    ...scenario, key, date: today, slot,
    status: 'pending', createdAt: new Date().toISOString(),
  };
  await upsertDraft(draft);
  const when = slot === 'pm' ? 'вечірня' : 'ранкова';
  console.log(`[draft] ${when} чернетка: «${draft.theme}» (${draft.slides.length} слайдів)`);
  // Сповіщаємо лише про ПЛАНОВУ чернетку. Коли власник сам натиснув «Інша
  // тема» — він уже в мінідодатку й побачить результат там, зайве повідомлення
  // у Telegram тільки заважає.
  if (!silent) {
    await notify(
      `📝 Тема (${when}):\n${draft.theme}\n\nСценарій із ${draft.slides.length} слайдів готовий — переглянь, за потреби виправ і затвердь.`,
      openAppMarkup('draft'),
    );
  }
  return draft;
}

// Один прохід черги. Лок, щоб паралельні виклики (таймер + ручний тригер) не
// накладались і не робили подвійну генерацію.
let polling = false;
export async function pollOnce() {
  if (polling) return 0;
  if (!videoFolderId()) {
    console.warn('[monitor] VIDEO_FOLDER_ID не задано — пропускаю прохід (нема куди класти відео).');
    return 0;
  }
  polling = true;
  try {
    return await pollOnceInner();
  } finally {
    polling = false;
  }
}

async function pollOnceInner() {
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

// Цикл моніторингу для процесу на Railway. Сам себе переплановує: наступний
// прохід — через FAST_MS у вікні появи тем, інакше через SLOW_MS.
export function startMonitor() {
  let running = false;
  let timer = null;
  const tick = async () => {
    if (!running) {
      running = true;
      try {
        // Чернетка сценарію на слот (08:00 / 16:00) — не критична для черги.
        await ensureDailyDraft().catch((e) => console.error('[draft]', e.message));
        const n = await pollOnce();
        console.log(`[monitor] перевірено чергу: ${n} готових DONE`);
      } catch (error) {
        console.error('[monitor] цикл упав:', error.message);
      } finally {
        running = false;
      }
    }
    const next = inActiveWindow() ? FAST_MS : SLOW_MS;
    timer = setTimeout(tick, next);
  };
  console.log(`[monitor] старт (вікно: ${Math.round(FAST_MS / 60000)} хв, поза вікном: ${Math.round(SLOW_MS / 60000)} хв)`);
  tick(); // перший прохід одразу (ловить усе, що з'явилось під час простою)
  return { stop: () => timer && clearTimeout(timer) };
}
