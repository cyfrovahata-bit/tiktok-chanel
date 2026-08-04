// Монітор черги тем.
//
// ChatGPT за відкладеними завданнями пише теми (рядок NEW із промтом) і
// малює для них фото (рядок стає DONE з архівом). Бот у це не втручається:
// він читає таблицю, розповідає власнику про кожен етап і монтує відео,
// щойно з'являється DONE з архівом. До розкладу ChatGPT не прив'язаний —
// орієнтується лише на статуси, тож кількість постів на добу можна міняти,
// не чіпаючи код.
//
// Головний критерій готовності — статус DONE у Google Sheet (не час). Драйв
// тримає готові відео (папка «video»), і НАЯВНІСТЬ файла <ID>.mp4 там =
// «вже змонтовано». Тому додаток без стану: Volume і леджер не потрібні —
// джерело правди Sheet + Drive.
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
import { readNotices, writeNotices } from './notices.js';
import { listVideos, uploadVideo, videoName, videoFolderId } from './videos.js';
import { extractPhotoArchive } from './archive.js';
import { assembleVideo } from './pipeline.js';
import { sendMessage, ownerChatId } from './telegram.js';

// Опитуємо таблицю рівномірно цілу добу. Раніше були «активні вікна» під
// конкретні години ChatGPT — але розклад міняється (два пости на добу, три,
// ручні запуски), і кожна зміна вимагала правити ще й вікна. Рівний інтервал
// коштує кілька зайвих читань Sheets на добу й прибирає цілий клас помилок
// «згенерував о 12:10, а бот помітив о 14:45».
const POLL_MS = Number(process.env.POLL_MS) || 3 * 60 * 1000;
const MAX_ATTEMPTS = 3;

const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tiktok-chanel-production.up.railway.app').replace(/\/$/, '');

// Спроби на кожен ID у межах життя процесу (щоб не спамити «знайшов тему»
// на кожній ітерації, коли монтаж падає, і зупинитись після MAX_ATTEMPTS).
// Пам'ятаємо ще посилання на архів і час останньої спроби: майже завжди
// причина падіння — у самому архіві, тож ЗАМІНА архіву має одразу дати нову
// спробу, а не впертись у вичерпаний лічильник до перезапуску процесу.
const attempts = new Map(); // id → { count, archive, lastAt }
const RETRY_AFTER_MS = Number(process.env.RETRY_AFTER_MS) || 30 * 60 * 1000;

function attemptCount(id) { return attempts.get(id)?.count ?? 0; }

// Чи пропускаємо цей матеріал цього проходу.
function giveUpOn(item) {
  const a = attempts.get(item.id);
  if (!a || a.count < MAX_ATTEMPTS) return false;
  if (a.archive !== item.archive) { attempts.delete(item.id); return false; } // новий архів — пробуємо
  if (Date.now() - a.lastAt >= RETRY_AFTER_MS) { attempts.delete(item.id); return false; } // час минув
  return true;
}

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
  const tried = attemptCount(item.id);
  // «Знайшов тему» — лише на першій спробі (як у прикладі: «Архів знайдено»).
  if (tried === 0) {
    await notify(`🔎 Знайшов нову тему:\n${item.title}\n\nАрхів знайдено — генерую відео…`);
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'monitor-'));
  const zipPath = path.join(workDir, 'archive.zip');
  await downloadArchive(item.archive, zipPath);
  const zipBuffer = await readFile(zipPath);
  const { photoPaths, scriptText } = await extractPhotoArchive(zipBuffer);

  // Скільки слайдів затверджено — записано в колонці F ще при створенні рядка.
  // Якщо в архіві інша кількість фото, справжня причина саме тут, а не в
  // розбіжності «рядки script.txt ≠ фото», яку побачив би конвеєр далі.
  const wanted = Number(item.slides);
  if (Number.isInteger(wanted) && wanted > 0 && photoPaths.length !== wanted) {
    throw new Error(
      `Фото в архіві (${photoPaths.length}) не збігається із затвердженим сценарієм (${wanted} слайдів). `
      + 'Перезбери архів рівно на стільки фото, скільки рядків у сценарії.',
    );
  }

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

// Останній прохід черги — видно в /healthz. Без цього «нічого не сталося»
// не відрізнити від «монтаж триває» чи «впало й мовчить».
let pollState = {
  lastRunAt: null, lastDoneCount: null, busyWith: null,
  lastGeneratedId: null, lastGeneratedAt: null, lastError: null,
};
export function pollStatus() {
  return { ...pollState, attempts: Object.fromEntries(attempts) };
}

// --- Спостереження за етапами конвеєра --------------------------------------
// Теми й фото робить ChatGPT за відкладеними завданнями. Бот у це не
// втручається — читає таблицю й розповідає власнику, що змінилося. Оголошений статус кожного рядка пам'ятаємо на
// Drive, щоб не повторювати повідомлення й переживати перезапуск.
let watchState = { lastRunAt: null, lastError: null, announced: 0 };
export function watchStatus() { return { ...watchState }; }

function stageMessage(item) {
  if (item.status === 'NEW') {
    // Рядки OWN- створює сам власник із мінідодатка, і про них він уже отримав
    // підтвердження в момент надсилання. Головне — не написати про них «сюжет
    // готовий і перевірений»: там лише сира розповідь, ChatGPT її ще не бачив.
    if (String(item.id).startsWith('OWN-')) return null;
    return `📝 Тема на сьогодні:\n${item.theme}\n\n`
      + `Сюжет готовий і перевірений${item.slides ? `, ${item.slides} слайдів` : ''}. `
      + 'Можеш поправити текст у таблиці — далі ChatGPT почне малювати фото.';
  }
  if (item.status === 'ERROR') {
    return `⚠️ ChatGPT зупинився на темі:\n${item.theme}\n\n`
      + `${item.note || 'Причину він не вказав.'}\n\nЦей рядок я пропускаю.`;
  }
  return null;
}

// Один прохід спостерігача: оголошує нові NEW і ERROR. Перехід у DONE
// оголошує сам конвеєр монтажу («знайшов тему» → «відео згенеровано»),
// тому тут DONE лише запам'ятовуємо, щоб не сказати про нього двічі.
export async function watchStages() {
  watchState = { ...watchState, lastRunAt: new Date().toISOString() };
  const [items, seen] = await Promise.all([readAllItems(), readNotices()]);
  let changed = false;
  let announced = 0;

  // ChatGPT інколи створює два рядки з ОДНАКОВИМ ID (два паралельні запуски в
  // ту саму хвилину: кожен прочитав таблицю до того, як інший записав рядок).
  // Пам'ять оголошених статусів лежить за ID, тож такі рядки щопроходу
  // перезаписували стан один одного: NEW → DONE → знову «NEW не оголошено» —
  // і «Тема на сьогодні» летіла в Telegram кожні три хвилини без кінця.
  // Для дублікатів ключем стає ID + номер рядка; для решти ключ незмінний,
  // щоб деплой не перечитав усю таблицю як нову.
  const perId = new Map();
  for (const it of items) if (it.id) perId.set(it.id, (perId.get(it.id) ?? 0) + 1);
  const keyOf = (item) => (perId.get(item.id) > 1 ? `${item.id}#${item.rowNumber}` : item.id);

  for (const item of items) {
    if (!item.id) continue;
    const key = keyOf(item);
    if (seen[key] === item.status) continue;
    const first = seen[key] === undefined;
    seen[key] = item.status;
    changed = true;
    // Рядки, які вже існували до появи цього спостерігача, не оголошуємо:
    // інакше перший запуск вивалив би в чат усю історію таблиці.
    if (first && item.status !== 'NEW') continue;
    const text = stageMessage(item);
    if (text) { await notify(text); announced++; }
  }

  // Про сам дубль повідомляємо один раз: далі рядки живуть окремо, але
  // однакові ID зіпсують іменування MP4 на Drive (файл зветься за ID, і
  // другий ролик перезапише перший), тож це треба виправити руками.
  for (const [id, count] of perId) {
    if (count < 2) continue;
    const key = `dupe:${id}`;
    if (seen[key] === String(count)) continue;
    seen[key] = String(count);
    changed = true;
    await notify(
      `⚠️ У таблиці ${count} рядки з однаковим ID «${id}».\n\n`
      + 'Заміни ID в одному з них (напр. додай «-2»): за ID називається файл '
      + 'відео на Drive, тож другий ролик перезапише перший.',
    );
    announced++;
  }

  if (changed) await writeNotices(seen);
  watchState = { ...watchState, lastError: null, announced };
  return announced;
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

// Попередження про биту збірку — ОДНЕ на архів, а не кожні пів години.
//
// Після MAX_ATTEMPTS лічильник спроб чекає RETRY_AFTER_MS і скидається, тож
// рядок із назавжди битим ZIP заходив на нове коло, знову падав тричі й знову
// слав те саме повідомлення — і так до заміни архіву. Причина падіння майже
// завжди в самому архіві, тож поки посилання не змінилося, повторний текст
// нічого не додає, лише витісняє з чату те, на що варто дивитись.
//
// Пам'ять — той самий notices.json на Drive (ключ «fail:<ID>» → посилання на
// архів), тому перезапуск Railway не починає спам заново. Нове посилання в
// колонці «Архів» дає і нову спробу, і, якщо вона теж впаде, нове попередження.
async function warnOncePerArchive(item, message) {
  const key = `fail:${item.id}`;
  const archive = item.archive || '';
  let seen = {};
  try {
    seen = await readNotices();
    if (seen[key] === archive) return false;
  } catch {
    seen = {}; // Drive недоступний — краще попередити вдруге, ніж змовчати
  }
  await notify(message);
  seen[key] = archive;
  await writeNotices(seen).catch(() => {});
  return true;
}

async function pollOnceInner() {
  const [items, videos] = await Promise.all([listDoneItems(), listVideos()]);
  pollState = { ...pollState, lastRunAt: new Date().toISOString(), lastDoneCount: items.length };
  let generated = 0;
  for (const item of items) {
    if (videos.has(videoName(item.id))) continue; // відео вже є → готове
    if (giveUpOn(item)) continue; // тричі впало на цьому ж архіві — чекаємо
    try {
      pollState = { ...pollState, busyWith: item.id };
      await processItem(item);
      generated++;
      pollState = {
        ...pollState, busyWith: null, lastError: null,
        lastGeneratedId: item.id, lastGeneratedAt: new Date().toISOString(),
      };
    } catch (error) {
      const tried = attemptCount(item.id) + 1;
      attempts.set(item.id, { count: tried, archive: item.archive, lastAt: Date.now() });
      pollState = { ...pollState, busyWith: null, lastError: `${item.id} (спроба ${tried}): ${error.message}` };
      console.error(`Помилка обробки ${item.id} (спроба ${tried}):`, error.message);
      if (tried >= MAX_ATTEMPTS) {
        await warnOncePerArchive(
          item,
          `⚠️ Не вдалося зробити відео для «${item.title}» після ${MAX_ATTEMPTS} спроб:\n${error.message}`
          + '\n\nЗаміни архів у таблиці — і я одразу спробую знову.',
        );
      }
    }
  }
  return items.length;
}

// Цикл моніторингу для процесу на Railway. Сам себе переплановує: наступний
// прохід — через POLL_MS.
export function startMonitor() {
  let running = false;
  let timer = null;
  const tick = async () => {
    if (!running) {
      running = true;
      try {
        // Спостерігач етапів — не критичний для монтажу, тож його падіння не
        // має зупиняти чергу. Але мовчати про нього теж не можна.
        await watchStages().catch((error) => {
          watchState = { ...watchState, lastError: error.message };
          console.error('[watch]', error.message);
        });
        const n = await pollOnce();
        console.log(`[monitor] перевірено чергу: ${n} готових DONE`);
      } catch (error) {
        console.error('[monitor] цикл упав:', error.message);
      } finally {
        running = false;
      }
    }
    timer = setTimeout(tick, POLL_MS);
  };
  console.log(`[monitor] старт (перевірка кожні ${Math.round(POLL_MS / 60000)} хв)`);
  tick(); // перший прохід одразу (ловить усе, що з'явилось під час простою)
  return { stop: () => timer && clearTimeout(timer) };
}
