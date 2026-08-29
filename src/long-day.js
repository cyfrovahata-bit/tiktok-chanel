// Денний цикл довгої збірки: підбір → монтаж → заливка.
//
// Три кроки рознесені в часі на години:
//   08:00 — підбираємо сюжети, придумуємо тему, пишемо власникові;
//   16:00 — монтуємо (потрібне прев'ю, яке власник завантажив за день);
//   18:00 — заливаємо на YouTube і нагадуємо про Facebook.
//
// Між кроками контейнер Railway перезапускається скільки завгодно разів, тож
// стан дня живе НЕ в пам'яті процесу, а окремим JSON-файлом на Drive. Він же
// захищає від подвійної роботи: тік ходить щохвилини, а зробити монтаж двічі
// означало б спалити півгодини й видати дві різні збірки.
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { drive } from './drive.js';
import { readAllItems } from './sheets.js';
import { listVideoFiles, videoProps, uploadVideo, markCompiled, streamVideo, videoName } from './videos.js';
import { chatOnce } from './openai.js';
import { sendMessage, ownerChatId } from './telegram.js';
import { fetchPreview } from './preview.js';
import { compileLong, orderEpisodes } from './compile-long.js';
import { publishYouTubeLong } from './youtube.js';
import { candidates, plannedSize, buildThemePrompt, parseThemeSet, DEFAULTS } from './long-plan.js';
import {
  metaPrompt, parseMeta, youtubeDescription, facebookPost, hookPrompt,
  previewPromptVideo, previewPromptYouTube,
} from './long-copy.js';
import { kyivToday, kyivMinutes } from './kyiv.js';

export const NOTIFY_AT = 8 * 60;   // 08:00 — ранкове повідомлення
export const BUILD_AT = 16 * 60;   // 16:00 — дедлайн прев'ю й початок монтажу
export const PUBLISH_AT = 18 * 60; // 18:00 — вихід

// Що робити просто зараз. Чиста функція: саме тут вирішується, чи не зроблено
// вже все, і саме її найдешевше перевірити тестом.
export function nextStep(plan, { minutes, size }) {
  if (!size) return 'none';
  if (!plan) return minutes >= NOTIFY_AT ? 'plan' : 'wait';
  if (plan.cancelled) return 'none';
  if (plan.youtubeId) return 'none';
  if (!plan.builtAt) return minutes >= BUILD_AT ? 'build' : 'wait';
  return minutes >= PUBLISH_AT ? 'publish' : 'wait';
}

// --- Стан дня на Drive -------------------------------------------------------

function folderId() {
  const id = process.env.VIDEO_FOLDER_ID || '';
  if (!id) throw new Error('Не задано VIDEO_FOLDER_ID');
  return id;
}

export function planName(date) {
  return `long-${date}.json`;
}

async function findPlanFile(date) {
  const res = await drive().files.list({
    q: `'${folderId()}' in parents and name = '${planName(date)}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0] || null;
}

export async function readPlan(date) {
  const file = await findPlanFile(date);
  if (!file) return null;
  const res = await drive().files.get(
    { fileId: file.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' },
  );
  try {
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch {
    return null;
  }
}

export async function writePlan(plan) {
  const body = JSON.stringify(plan, null, 2);
  const media = { mimeType: 'application/json', body };
  const existing = await findPlanFile(plan.date);
  if (existing) {
    await drive().files.update({ fileId: existing.id, media, fields: 'id', supportsAllDrives: true });
  } else {
    await drive().files.create({
      requestBody: { name: planName(plan.date), parents: [folderId()], mimeType: 'application/json' },
      media,
      fields: 'id',
      supportsAllDrives: true,
    });
  }
  return plan;
}

// Назви попередніх добірок — щоб модель не назвала цю так само. Дивимось на
// тиждень назад: далі глядач уже не пам'ятає.
async function recentTitles(date, back = 10) {
  const out = [];
  const [y, m, d] = date.split('-').map(Number);
  for (let i = 1; i <= back; i++) {
    const at = new Date(Date.UTC(y, m - 1, d - i));
    const day = at.toISOString().slice(0, 10);
    const plan = await readPlan(day).catch(() => null);
    if (plan?.title) out.push(plan.title);
  }
  return out;
}

async function notify(text) {
  try {
    await sendMessage(ownerChatId(), text);
  } catch (error) {
    console.error('[long-day] Telegram:', error.message);
  }
}

// --- Крок 1: підбір ----------------------------------------------------------

export async function planDay({ now = new Date(), ask = chatOnce, notifyFn = notify } = {}) {
  const date = kyivToday(now);
  const size = plannedSize(now);
  if (!size) return null;

  const [items, files] = await Promise.all([readAllItems(), listVideoFiles()]);
  const published = items.filter((it) => it.status === 'PUBLISHED');
  const pool = candidates(published, {
    today: date,
    // П'ятнадцять на тиждень із карантином не набереться — там повтори
    // дозволені свідомо.
    cooldownDays: size >= 15 ? 0 : DEFAULTS.cooldownDays,
    compiledAt: (id) => videoProps(files, id).compiledAt || null,
  });

  if (pool.length < size) {
    await notifyFn(`⚠️ Добірка на ${size} сюжетів не збирається: придатних лише ${pool.length}.`);
    return writePlan({ date, size, cancelled: true, reason: 'мало придатних сюжетів' });
  }

  const loose = size >= 15;
  const prompt = buildThemePrompt(pool, size, { loose, avoidTitles: await recentTitles(date) });
  let answer = '';
  try {
    answer = await ask(prompt);
  } catch (error) {
    console.error('[long-day] тему не підібрано:', error.message);
  }
  const set = parseThemeSet(answer, pool, size);
  const chosen = pool.filter((it) => set.ids.includes(String(it.id)));

  // Хук диктора: окремий запит, бо він вимагає іншого тону, ніж підбір теми.
  let hook = '';
  try {
    hook = String(await ask(hookPrompt({ title: set.title, theme: set.theme, items: chosen }))).trim();
  } catch (error) {
    console.error('[long-day] хук не згенеровано:', error.message);
  }

  const plan = {
    date,
    size,
    title: set.title || `${size} фактів про Україну`,
    theme: set.theme || '',
    hook: hook.replace(/^["«]|["»]$/g, '').trim(),
    ids: set.ids,
    labels: set.labels,
    toppedUp: set.toppedUp,
    plannedAt: new Date().toISOString(),
    // Промти складаємо одразу й кладемо в план: мінідодаток має віддати їх
    // кнопкою миттєво, а не збирати заново на кожне відкриття.
    prompts: {
      video: previewPromptVideo({ title: set.title, theme: set.theme, items: chosen }),
      youtube: previewPromptYouTube({ title: set.title, theme: set.theme, items: chosen }),
    },
  };
  await writePlan(plan);

  await notifyFn(
    `🎬 Підібрано ${size} сюжетів на сьогодні.\n\n`
    + `Тема: ${plan.title}\n${plan.theme ? `${plan.theme}\n` : ''}\n`
    + `${chosen.map((it, i) => `${i + 1}. ${plan.labels[i] || it.title}`).join('\n')}\n\n`
    + 'Промти на прев\'ю — у мінідодатку, кнопками «скопіювати».\n'
    + 'Прев\'ю для відео чекаю до 16:00, інакше о 18:00 вийде звичайний шортс.',
  );
  return plan;
}

// --- Крок 2: монтаж ----------------------------------------------------------

export async function buildDay({ now = new Date(), ask = chatOnce, notifyFn = notify, onProgress = () => {} } = {}) {
  const date = kyivToday(now);
  const plan = await readPlan(date);
  if (!plan || plan.cancelled || plan.builtAt) return plan;

  const previewPath = await fetchPreview(path.join(os.tmpdir(), `long-preview-${date}.jpg`)).catch(() => null);
  if (!previewPath) {
    await notifyFn(
      `🚫 Прев'ю до 16:00 не з'явилось — сьогоднішня добірка «${plan.title}» скасована.\n`
      + 'О 18:00 вийде звичайний шортс, як у будь-який інший день.',
    );
    return writePlan({ ...plan, cancelled: true, reason: 'немає прев\'ю до 16:00' });
  }

  const all = await readAllItems();
  const { items } = orderEpisodes(all, plan.ids);
  // Порядок сюжетів визначає таблиця, тож підписи треба переставити так само —
  // інакше диктор назве другим той об'єкт, який іде п'ятим.
  const labels = items.map((it) => {
    const at = plan.ids.indexOf(String(it.id));
    return at >= 0 ? (plan.labels?.[at] || '') : '';
  });

  onProgress(`монтую «${plan.title}»`);
  const result = await compileLong(items, {
    previewPath,
    labels,
    introBig: plan.title.toUpperCase(),
    introSpoken: plan.hook || undefined,
    onProgress,
  });

  const name = `compilation-${date}`;
  const fileId = await uploadVideo(name, result.path);
  await markCompiled(plan.ids).catch((error) => console.error('[long-day] мітки:', error.message));

  // Назва й опис — після монтажу: лише тепер відомі справжні таймкоди.
  let answer = '';
  try {
    answer = await ask(metaPrompt({ title: plan.title, theme: plan.theme, items }));
  } catch (error) {
    console.error('[long-day] тексти не згенеровано:', error.message);
  }
  const meta = parseMeta(answer, { title: plan.title, items });

  const built = {
    ...plan,
    builtAt: new Date().toISOString(),
    videoFileId: fileId,
    videoName: videoName(name),
    chapters: result.chapters,
    sizeBytes: result.size,
    meta: {
      youtubeTitle: meta.youtubeTitle,
      description: youtubeDescription({ description: meta.description, chapters: result.chapters, items }),
      facebook: facebookPost(meta),
    },
  };
  await writePlan(built);
  await notifyFn(
    `✅ Добірка «${plan.title}» змонтована (${(result.size / 1024 / 1024).toFixed(1)} МБ).\n`
    + 'О 18:00 піде на YouTube. Текст для Facebook — у мінідодатку.',
  );
  return built;
}

// --- Крок 3: заливка ---------------------------------------------------------

async function download(fileId) {
  const { stream } = await streamVideo(fileId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function publishDay({ now = new Date(), notifyFn = notify, upload = publishYouTubeLong } = {}) {
  const date = kyivToday(now);
  const plan = await readPlan(date);
  if (!plan || plan.cancelled || !plan.builtAt || plan.youtubeId) return plan;

  const videoBuffer = await download(plan.videoFileId);
  // Обкладинки може не бути — заливаємо без неї: відео о 18:00 важливіше за
  // картинку, а поставити її потім можна руками.
  let thumbnailBuffer = null;
  try {
    const at = await fetchPreview(path.join(os.tmpdir(), `long-thumb-${date}.jpg`), 'youtube');
    if (at) thumbnailBuffer = await readFile(at);
  } catch (error) {
    console.error('[long-day] обкладинка:', error.message);
  }

  const out = await upload({
    videoBuffer,
    title: plan.meta.youtubeTitle,
    description: plan.meta.description,
    thumbnailBuffer,
  });

  const done = { ...plan, youtubeId: out.id, publishedAt: new Date().toISOString(), thumbnail: out.thumbnail };
  await writePlan(done);
  await notifyFn(
    `📺 «${plan.meta.youtubeTitle}» на YouTube: https://youtu.be/${out.id}\n`
    + `Обкладинка: ${out.thumbnail}.${out.forcedPrivate ? '\n⚠️ Відео стало приватним — аудит YouTube API не пройдено.' : ''}\n\n`
    + 'Facebook лишається за тобою — відео й текст у мінідодатку.',
  );
  return done;
}

// --- Тік ---------------------------------------------------------------------

export async function runLongDayOnce({ now = new Date(), ...deps } = {}) {
  const size = plannedSize(now);
  if (!size) return { status: 'not-a-compilation-day' };

  const date = kyivToday(now);
  const plan = await readPlan(date).catch(() => null);
  const step = nextStep(plan, { minutes: kyivMinutes(now), size });
  if (step === 'plan') return { status: 'planned', plan: await planDay({ now, ...deps }) };
  if (step === 'build') return { status: 'built', plan: await buildDay({ now, ...deps }) };
  if (step === 'publish') return { status: 'published', plan: await publishDay({ now, ...deps }) };
  return { status: step };
}

// Чи виходить сьогодні довга збірка. Автопублікація питає це, щоб знати, чи
// віддавати вечірній слот YouTube. Помилка читання — вважаємо, що виходить:
// зайвий пропуск шортса дешевший за подвійну публікацію.
export async function compilationStillOn(now = new Date()) {
  if (!plannedSize(now)) return false;
  try {
    const plan = await readPlan(kyivToday(now));
    return !plan?.cancelled;
  } catch {
    return true;
  }
}
