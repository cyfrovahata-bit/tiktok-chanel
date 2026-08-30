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
import {
  listVideoFiles, videoProps, uploadVideo, markCompiled, streamVideo, videoName,
  setVideoAppProperties,
} from './videos.js';
import { chatOnce } from './openai.js';
import { sendMessage, ownerChatId } from './telegram.js';
import { fetchPreview, removePreview, normalizeThumbnail } from './preview.js';
import { compileLong, orderEpisodes } from './compile-long.js';
import { publishYouTubeLong, setYouTubeThumbnail } from './youtube.js';
import {
  candidates, plannedSize, buildThemePrompt, parseThemeSet, buildTitlePrompt,
  parseTitleAnswer, neutralTitle, cleanLabel, DEFAULTS,
} from './long-plan.js';
import {
  metaPrompt, parseMeta, youtubeDescription, facebookPost,
  previewPromptVideo, previewPromptYouTube, unitePrompt, parseTail, tailWeakness,
} from './long-copy.js';
import { INTRO_OPENERS, introLine } from './voice-bank.js';
import { kyivToday, kyivMinutes } from './kyiv.js';

// Тексти добірки — вступ, назва, опис — пише сильніша модель, ніж решта
// каналу. Їх усього кілька на тиждень, а різниця чутна одразу: gpt-4o-mini
// раз за разом видавав «чи знаєш ти, що…?» і «далі покажемо ще більше»,
// хоч у промті це прямо заборонено.
const COPY_MODEL = process.env.LONG_COPY_MODEL || 'gpt-4o';
const COPY = { model: COPY_MODEL };

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

// --- Скид дня ----------------------------------------------------------------
// «Переробити з нуля»: коли добірка зібралася не такою, як треба (тема
// збрехала, вступ порожній, прев'ю не про те), латати її по частинах немає
// сенсу — усе одно перемонтовувати. Тому скидаємо день до стану «нічого не
// було»: прибираємо змонтований файл, знімаємо з епізодів мітку «вже в
// добірці» (інакше карантин на три тижні викинув би їх із нового підбору) і
// видаляємо прев'ю, бо на ньому стоїть стара назва.
export async function resetDay({ now = new Date(), previews = true } = {}) {
  const date = kyivToday(now);
  const plan = await readPlan(date).catch(() => null);
  const removed = { video: false, marks: [], previews: [], plan: false };
  if (!plan) return removed;

  if (plan.videoFileId) {
    try {
      await drive().files.delete({ fileId: plan.videoFileId, supportsAllDrives: true });
      removed.video = true;
    } catch (error) {
      console.error('[long-day] змонтоване відео не видалив:', error.message);
    }
  }

  const files = await listVideoFiles().catch(() => new Map());
  for (const id of plan.ids || []) {
    const file = files.get(videoName(id));
    if (!file?.appProperties?.compiledAt) continue;
    try {
      await setVideoAppProperties(file.id, { compiledAt: null });
      removed.marks.push(id);
    } catch (error) {
      console.error(`[long-day] мітку з ${id} не зняв:`, error.message);
    }
  }

  if (previews) {
    for (const kind of ['video', 'youtube']) {
      try {
        if (await removePreview(kind)) removed.previews.push(kind);
      } catch (error) {
        console.error(`[long-day] прев'ю ${kind} не прибрав:`, error.message);
      }
    }
  }

  const file = await findPlanFile(date);
  if (file) {
    await drive().files.delete({ fileId: file.id, supportsAllDrives: true });
    removed.plan = true;
  }
  return removed;
}

// Вступ диктора. Початок фрази сталий і задає настрій, а хвіст — про ЦЮ
// добірку: «Чи знав ти таку Україну? 5 історій, вибитих у камені.»
//
// Просити в моделі всю фразу ми пробували чотири рази й щоразу отримували не
// те: анонс одного об'єкта з п'яти, запитання, на яке легко відповісти «ні»,
// порожню обіцянку «далі покажемо ще більше». Хвіст із двох-шести слів вона
// пише надійно, а перевірити його можна кодом — що ми й робимо.
export function introVariantFor(date, shift = 0) {
  const digits = String(date).replace(/\D/g, '');
  const base = Number(digits.slice(-4)) || 0;
  return (base + Number(shift || 0)) % INTRO_OPENERS.length;
}

async function makeTail({ ask, title, theme, chosen, size }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let tail = '';
    try {
      tail = parseTail(await ask(unitePrompt({ title, theme, items: chosen, size }), COPY));
    } catch (error) {
      console.error('[long-day] хвіст вступу не згенеровано:', error.message);
      return '';
    }
    const weak = tailWeakness(tail, { items: chosen, title });
    if (!weak) return tail;
    console.error(`[long-day] хвіст «${tail}» не підійшов (${weak})`);
  }
  // Двічі не вийшло — лишається сталий хвіст. Він загальний, зате чесний.
  return '';
}

// Перегенерувати САМ вступ, не чіпаючи набору, назви й прев'ю. Потрібно, коли
// текст не сподобався: переробляти через повний скид означало б малювати
// прев'ю заново.
export async function rehookDay({ now = new Date(), ask = chatOnce } = {}) {
  const date = kyivToday(now);
  const plan = await readPlan(date);
  if (!plan || plan.cancelled) return plan;

  // Міняємо і початок фрази, і хвіст: якщо власник тисне кнопку, його не
  // влаштував увесь вступ, а не якась одна його половина.
  const all = await readAllItems();
  const { items } = orderEpisodes(all, plan.ids);
  const introVariant = ((plan.introVariant ?? introVariantFor(date)) + 1) % INTRO_OPENERS.length;
  const introTail = await makeTail({
    ask, title: plan.title, theme: plan.theme, chosen: items, size: plan.size,
  });
  return writePlan({
    ...plan, introVariant, introTail, hook: introLine(plan.size, introVariant, introTail),
  });
}

// Перезібрати вже змонтоване. Скид (resetDay) для цього завеликий: він
// перебирає набір і викидає прев'ю, яке власник малював пів години. Тут же
// набір, назва, вступ і прев'ю лишаються, а зникає лише саме відео — щоб
// монтаж пішов заново новим кодом чи з новим вступом.
export async function rebuildDay({ now = new Date() } = {}) {
  const date = kyivToday(now);
  const plan = await readPlan(date);
  if (!plan) return null;
  if (plan.youtubeId) throw new Error('Добірка вже на YouTube — перезбирати пізно');
  if (!plan.builtAt) return plan;

  if (plan.videoFileId) {
    try {
      await drive().files.delete({ fileId: plan.videoFileId, supportsAllDrives: true });
    } catch (error) {
      console.error('[long-day] старе відео не видалив:', error.message);
    }
  }
  // Мітки «вже в добірці» лишаємо: набір той самий, і знімати їх означало б
  // дозволити цим фактам потрапити в наступну добірку без карантину.
  const next = { ...plan };
  for (const key of ['builtAt', 'videoFileId', 'videoName', 'chapters', 'sizeBytes', 'meta', 'failures', 'lastError']) {
    delete next[key];
  }
  return writePlan(next);
}

// --- Крок 1: підбір ----------------------------------------------------------

export async function planDay({ now = new Date(), ask = chatOnce, notifyFn = notify } = {}) {
  const date = kyivToday(now);
  const size = plannedSize(now);
  if (!size) return null;

  const [items, files] = await Promise.all([readAllItems(), listVideoFiles()]);
  const published = items
    .filter((it) => it.status === 'PUBLISHED')
    // Без готового MP4 у папці добірку не зібрати: монтаж бере саме файл, а не
    // рядок таблиці. Старі ролики з Drive іноді прибирають — і такий епізод
    // валив увесь монтаж уже на першому кроці.
    .filter((it) => files.has(videoName(it.id)));
  const pool = candidates(published, {
    today: date,
    // П'ятнадцять на тиждень із карантином не набереться — там повтори
    // дозволені свідомо.
    cooldownDays: size >= 15 ? 0 : DEFAULTS.cooldownDays,
    compiledAt: (id) => videoProps(files, id).compiledAt || null,
  });

  if (pool.length < size) {
    await notifyFn(`⚠️ Добірка на ${size} фактів не збирається: придатних лише ${pool.length}.`);
    return writePlan({ date, size, cancelled: true, reason: 'мало придатних фактів' });
  }

  const avoidTitles = await recentTitles(date);
  const loose = size >= 15;
  const prompt = buildThemePrompt(pool, size, { loose, avoidTitles });
  let answer = '';
  try {
    answer = await ask(prompt);
  } catch (error) {
    console.error('[long-day] тему не підібрано:', error.message);
  }
  const set = parseThemeSet(answer, pool, size);
  const chosen = pool.filter((it) => set.ids.includes(String(it.id)));

  // Назву перепитуємо ОКРЕМО і вже по фактичному набору. Той самий запит, що
  // обирає сюжети, назву дає невідповідну: не набравши п'яти замків, модель
  // добирає до них собор і бур'ян, а назву «5 замків України» лишає. Тут вона
  // мусить перелічити ID, які назва накриває, — і назва, що накрила не всіх,
  // не проходить.
  let named = { title: '', theme: set.theme, honest: false, missed: [] };
  for (const attempt of [1, 2]) {
    let extra = '';
    if (attempt === 2) {
      // Друга спроба з конкретикою: називаємо ті сюжети, повз які назва
      // промахнулась. Без цього модель здебільшого повторює ту саму.
      const missed = chosen.filter((it) => named.missed.includes(String(it.id)));
      extra = `\n\nНАЗВА «${named.title}» НЕ ПІДІЙШЛА: вона не про ці факти:\n`
        + `${missed.map((it) => `• ${it.title || it.theme}`).join('\n')}\n`
        + 'Дай ширшу назву, під яку підпадають і вони теж.';
    }
    try {
      named = parseTitleAnswer(
        await ask(buildTitlePrompt(chosen, { avoidTitles }) + extra, COPY),
        set.ids,
      );
    } catch (error) {
      console.error('[long-day] назву не перевірено:', error.message);
      break;
    }
    if (named.honest) break;
    console.error(
      `[long-day] назва «${named.title}» не накриває ${named.missed.length} фактів`,
    );
  }
  const title = named.honest ? named.title : neutralTitle(size, avoidTitles);
  const theme = named.theme || set.theme || '';

  const introVariant = introVariantFor(date);
  const introTail = await makeTail({ ask, title, theme, chosen, size });
  const hook = introLine(size, introVariant, introTail);

  const plan = {
    date,
    size,
    title,
    theme,
    hook,
    introVariant,
    introTail,
    ids: set.ids,
    // Підпис-огризок («Як кормова культура перетворилася») диктор прочитає як
    // обірвану думку — краще сам номер факту.
    labels: set.labels.map(cleanLabel),
    toppedUp: set.toppedUp,
    titleHonest: named.honest,
    plannedAt: new Date().toISOString(),
    // Промти складаємо одразу й кладемо в план: мінідодаток має віддати їх
    // кнопкою миттєво, а не збирати заново на кожне відкриття.
    prompts: {
      video: previewPromptVideo({ title, theme, items: chosen }),
      youtube: previewPromptYouTube({ title, theme, items: chosen }),
    },
  };
  await writePlan(plan);

  await notifyFn(
    `🎬 Підібрано ${size} фактів на сьогодні.\n\n`
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
  let result;
  let fileId;
  const name = `compilation-${date}`;
  try {
    result = await compileLong(items, {
      previewPath,
      labels,
      introBig: plan.title.toUpperCase(),
      introSpoken: plan.hook || undefined,
      onProgress,
    });
    fileId = await uploadVideo(name, result.path);
  } catch (error) {
    // Тік ходить щохвилини, тож без лічильника невдалий монтаж бився б у ту
    // саму стіну до кінця доби. Три спроби — і день закривається, а вечірній
    // слот повертається шортсу.
    const failures = (plan.failures || 0) + 1;
    const next = { ...plan, failures, lastError: error.message };
    if (failures >= 3) {
      next.cancelled = true;
      next.reason = `монтаж не вдався тричі: ${error.message}`;
      await notifyFn(
        `🚫 Добірка «${plan.title}» не збирається: ${error.message}\n`
        + 'Спробував тричі. О 18:00 вийде звичайний шортс.',
      );
    }
    await writePlan(next);
    throw error;
  }
  await markCompiled(plan.ids).catch((error) => console.error('[long-day] мітки:', error.message));

  // Назва й опис — після монтажу: лише тепер відомі справжні таймкоди.
  let answer = '';
  try {
    answer = await ask(metaPrompt({ title: plan.title, theme: plan.theme, items }), COPY);
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

// Обкладинка для YouTube. Її ЗАВЖДИ переганяємо в JPEG 1280×720 під два
// мегабайти: ChatGPT віддає PNG, на Drive він лягає з іменем .jpg, і саме на
// цьому перша заливка добірки дістала «The provided image content is invalid».
async function readThumbnail(date) {
  try {
    const at = await fetchPreview(path.join(os.tmpdir(), `long-thumb-${date}.jpg`), 'youtube');
    if (!at) return null;
    const ready = await normalizeThumbnail(at, path.join(os.tmpdir(), `long-thumb-${date}-ready.jpg`));
    return readFile(ready.path);
  } catch (error) {
    console.error('[long-day] обкладинка:', error.message);
    return null;
  }
}

// Доставити обкладинку на вже залите відео. Потрібно, коли заливка пройшла, а
// картинка — ні: перезаливати відео заради неї безглуздо.
export async function retryThumbnail({ now = new Date(), setThumb = setYouTubeThumbnail } = {}) {
  const date = kyivToday(now);
  const plan = await readPlan(date);
  if (!plan?.youtubeId) throw new Error('Добірка ще не на YouTube');
  const buffer = await readThumbnail(date);
  if (!buffer) throw new Error('Обкладинки 16:9 немає — завантаж її в мінідодатку');
  await setThumb(plan.youtubeId, buffer);
  return writePlan({ ...plan, thumbnail: 'поставлено' });
}

export async function publishDay({ now = new Date(), notifyFn = notify, upload = publishYouTubeLong } = {}) {
  const date = kyivToday(now);
  const plan = await readPlan(date);
  if (!plan || plan.cancelled || !plan.builtAt || plan.youtubeId) return plan;

  const videoBuffer = await download(plan.videoFileId);
  // Обкладинки може не бути — заливаємо без неї: відео о 18:00 важливіше за
  // картинку, а поставити її потім можна руками.
  const thumbnailBuffer = await readThumbnail(date);

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
