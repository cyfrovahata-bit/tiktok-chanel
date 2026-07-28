// Спільна механіка відповідей на коментарі: знайти нові → написати чернетку →
// спитати власника в Telegram → опублікувати схвалене.
//
// Платформи відрізняються лише трьома діями — «дай нові коментарі», «опублікуй
// відповідь» і «як виглядає посилання на допис». Усе інше (стан, дедуплікація,
// картки, кнопки, ручне редагування) однакове, тож живе тут, а не тричі.
import { drive } from './drive.js';
import { promptFolderId } from './kyiv.js';
import { sendMessage, ownerChatId, answerCallbackQuery, editMessageReplyMarkup } from './telegram.js';
import { chatOnce } from './openai.js';

const FILE_NAME = 'comments.json';
const KEEP = 400;
const MAX_PER_RUN = Number(process.env.COMMENTS_PER_RUN) || 5;
const SKIP = 'ПРОПУСТИТИ';

// Реєстр платформ: ключ → адаптер. Заповнюється при старті (registerPlatform).
const platforms = new Map();

export function registerPlatform(adapter) {
  platforms.set(adapter.key, adapter);
}

// --- Стан на Drive -----------------------------------------------------------
// Один файл на всі платформи; ключі — «<платформа>:<id коментаря>».

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

async function readJson(fileId) {
  const res = await drive().files.get({ fileId, alt: 'media', supportsAllDrives: true });
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

// Перший запуск після поділу на платформи: підхоплюємо стан із часів, коли був
// лише YouTube. Без цього бот перепитав би про коментарі, на які вже відповіли,
// і під ними з'явилася б друга відповідь.
async function migrateFromYouTubeOnly() {
  const res = await drive().files.list({
    q: `'${promptFolderId()}' in parents and name = 'yt-comments.json' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const id = res.data.files?.[0]?.id;
  if (!id) return null;
  const old = await readJson(id).catch(() => null);
  if (!old) return null;
  const prefix = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [`yt:${k}`, v]));
  return { seen: prefix(old.seen), drafts: prefix(old.drafts) };
}

export async function readState() {
  const id = await findFile();
  if (!id) {
    const migrated = await migrateFromYouTubeOnly().catch(() => null);
    return migrated || { seen: {}, drafts: {} };
  }
  try {
    const data = await readJson(id);
    return { seen: data?.seen || {}, drafts: data?.drafts || {} };
  } catch {
    return { seen: {}, drafts: {} };
  }
}

export async function writeState(state) {
  const seen = Object.fromEntries(Object.entries(state.seen || {}).slice(-KEEP));
  const doc = { seen, drafts: state.drafts || {}, updatedAt: new Date().toISOString() };
  const media = { mimeType: 'application/json', body: JSON.stringify(doc, null, 2) };
  const existing = await findFile();
  if (existing) await drive().files.update({ fileId: existing, media, supportsAllDrives: true });
  else {
    await drive().files.create({
      requestBody: { name: FILE_NAME, parents: [promptFolderId()] },
      media, fields: 'id', supportsAllDrives: true,
    });
  }
  return doc;
}

// --- Чернетка ----------------------------------------------------------------

export function draftPrompt(comment, platformLabel = '') {
  return [
    'Ти — автор українського каналу коротких пізнавальних роликів «Чи Ви Знали?».',
    `Напиши коротку відповідь на коментар глядача${platformLabel ? ` в ${platformLabel}` : ''}.`,
    '',
    'Правила:',
    '- українською, до 200 символів, тепло й по-людськи, без канцеляриту;',
    '- без хештегів, без емодзі більше одного, без звертання «шановний»;',
    '- не вигадуй фактів: якщо коментар питає те, чого ти не знаєш напевно, чесно скажи;',
    '- на похвалу, подяку, короткий відгук чи саме емодзі — коротко подякуй;',
    '- якщо глядач ділиться власним досвідом — відгукнись на нього, не переказуй ролик;',
    '- якщо глядач вказує на помилку — подякуй за уточнення без виправдань;',
    `- ${SKIP} повертай ЛИШЕ у трьох випадках: образа, відверта провокація, спам чи реклама.`,
    '  У всіх інших випадках відповідай — навіть якщо в коментарі немає запитання;',
    '- поверни ЛИШЕ текст відповіді, без лапок і пояснень.',
    '',
    `Коментар від ${comment.author}:`,
    comment.text,
  ].join('\n');
}

export async function draftReply(comment, options = {}) {
  const ask = options.chat || chatOnce;
  const answer = String(await ask(draftPrompt(comment, options.platformLabel))).trim();
  if (!answer || answer.toUpperCase().startsWith(SKIP)) return null;
  return answer.replace(/^["'«»]+|["'«»]+$/g, '').slice(0, 900);
}

// --- Картка в Telegram -------------------------------------------------------

// Без чернетки кнопки «Надіслати» немає — надсилати нічого. Лишаються
// «Змінити» (написати свій текст) і «Пропустити».
function keyboard(platformKey, commentId, hasDraft = true) {
  const tail = `${platformKey}:${commentId}`;
  const row = [];
  if (hasDraft) row.push({ text: '✅ Надіслати', callback_data: `c:s:${tail}` });
  row.push({ text: '✏️ Змінити', callback_data: `c:e:${tail}` });
  row.push({ text: '🚫 Пропустити', callback_data: `c:x:${tail}` });
  return { inline_keyboard: [row] };
}

function card(adapter, comment, draft) {
  return [
    `${adapter.icon} Коментар · ${adapter.label}`,
    adapter.link(comment),
    '',
    `${comment.author}:`,
    comment.text,
    '',
    draft ? 'Відповідь від ШІ:' : '⚠️ Модель радить не відповідати (образа, провокація або спам).',
    draft || 'Якщо все ж хочеш — напиши свій текст відповіддю на це повідомлення.',
  ].filter((line) => line !== null).join('\n');
}

// --- Один прохід -------------------------------------------------------------

export async function checkPlatform(adapter, options = {}) {
  const state = options.state || await readState();
  const comments = await adapter.fetch(options);
  const fresh = comments.filter((c) => !state.seen[`${adapter.key}:${c.id}`]);
  const result = { platform: adapter.key, checked: comments.length, fresh: fresh.length, asked: 0, flagged: 0 };
  if (!fresh.length) return result;

  const notify = options.notifyFn || sendMessage;
  const chatId = options.chatId || ownerChatId();

  // Найстаріші першими, щоб відповіді йшли в порядку появи коментарів.
  for (const comment of fresh.reverse().slice(0, MAX_PER_RUN)) {
    const key = `${adapter.key}:${comment.id}`;
    let draft = null;
    try {
      draft = await draftReply(comment, { ...options, platformLabel: adapter.label });
    } catch (error) {
      console.error(`[comments:${adapter.key}] чернетка:`, error.message);
      continue; // спробуємо наступного разу
    }
    // Картка йде ЗАВЖДИ, навіть коли модель радить промовчати: власник має
    // бачити всі коментарі й вирішувати сам. Без чернетки просто немає кнопки
    // «Надіслати».
    const message = await notify(
      chatId,
      card(adapter, comment, draft),
      keyboard(adapter.key, comment.id, Boolean(draft)),
    );
    state.seen[key] = 'pending';
    state.drafts[key] = { text: draft || null, messageId: message?.message_id ?? null };
    if (draft) result.asked += 1; else result.flagged += 1;
  }

  if (!options.state) await writeState(state);
  return result;
}

export async function checkAll(options = {}) {
  const state = options.state || await readState();
  const results = [];
  for (const adapter of platforms.values()) {
    if (adapter.enabled && !adapter.enabled()) continue;
    try {
      results.push(await checkPlatform(adapter, { ...options, state }));
    } catch (error) {
      results.push({ platform: adapter.key, error: error.message });
    }
  }
  await writeState(state);
  return results;
}

// --- Кнопки й ручний текст ---------------------------------------------------

// Розбирає мітку кнопки. Крім нинішнього формату «c:<дія>:<платформа>:<id>»
// розуміє старий «ytc:<дія>:<id>» — картки, надіслані до поділу на платформи,
// висять у чаті й далі, а кнопка, яка мовчки нічого не робить, гірша за помилку.
export function parseCallbackData(data) {
  const parts = String(data || '').split(':');
  if (parts[0] === 'c' && parts.length >= 4) {
    return { action: parts[1], platformKey: parts[2], commentId: parts.slice(3).join(':') };
  }
  if (parts[0] === 'ytc' && parts.length >= 3) {
    return { action: parts[1], platformKey: 'yt', commentId: parts.slice(2).join(':') };
  }
  return null;
}

export async function handleCallback(callbackQuery, options = {}) {
  const parsed = parseCallbackData(callbackQuery?.data);
  if (!parsed) return false;
  const { action, platformKey, commentId } = parsed;
  const chatId = ownerChatId();
  if (String(callbackQuery.from?.id) !== chatId) return true;

  const adapter = platforms.get(platformKey);
  if (!adapter) { await answerCallbackQuery(callbackQuery.id, 'Платформа вимкнена'); return true; }

  const state = options.state || await readState();
  const key = `${platformKey}:${commentId}`;
  const draft = state.drafts[key];

  const finish = async (note) => {
    delete state.drafts[key];
    await writeState(state);
    if (callbackQuery.message?.message_id) {
      await editMessageReplyMarkup(chatId, callbackQuery.message.message_id).catch(() => {});
    }
    await answerCallbackQuery(callbackQuery.id, note);
  };

  if (action === 'x') {
    state.seen[key] = 'skipped';
    await finish('Пропущено');
    return true;
  }
  if (action === 'e') {
    await answerCallbackQuery(callbackQuery.id, 'Надішли свій текст відповіддю на це повідомлення');
    return true;
  }
  if (action === 's') {
    if (!draft?.text) {
      await answerCallbackQuery(callbackQuery.id, draft
        ? 'Чернетки немає — напиши свій текст відповіддю на повідомлення'
        : 'Чернетку вже використано');
      return true;
    }
    try {
      await adapter.reply(commentId, draft.text, options);
      state.seen[key] = 'sent';
      await finish('Опубліковано ✅');
    } catch (error) {
      await answerCallbackQuery(callbackQuery.id, `Не вдалося: ${error.message}`.slice(0, 190));
    }
    return true;
  }
  return true;
}

export async function handleMessage(message, options = {}) {
  const replyTo = message?.reply_to_message?.message_id;
  const text = String(message?.text || '').trim();
  if (!replyTo || !text) return false;
  if (String(message.from?.id) !== ownerChatId()) return false;

  const state = options.state || await readState();
  const entry = Object.entries(state.drafts).find(([, d]) => d.messageId === replyTo);
  if (!entry) return false;
  const [key] = entry;
  const [platformKey, ...rest] = key.split(':');
  const adapter = platforms.get(platformKey);
  if (!adapter) return false;

  const notify = options.notifyFn || sendMessage;
  try {
    await adapter.reply(rest.join(':'), text, options);
    state.seen[key] = 'sent';
    delete state.drafts[key];
    await writeState(state);
    await editMessageReplyMarkup(ownerChatId(), replyTo).catch(() => {});
    await notify(ownerChatId(), `✅ Твою відповідь опубліковано (${adapter.label}).`);
  } catch (error) {
    await notify(ownerChatId(), `⚠️ Не вдалося опублікувати відповідь: ${error.message}`);
  }
  return true;
}

// Скільки карток чекає рішення й по яких платформах. Текстів не віддаємо —
// у діагностиці вони ні до чого.
export async function pendingSummary() {
  const state = await readState();
  const byPlatform = {};
  for (const key of Object.keys(state.drafts || {})) {
    const platform = key.split(':')[0];
    byPlatform[platform] = (byPlatform[platform] || 0) + 1;
  }
  const statuses = {};
  for (const value of Object.values(state.seen || {})) {
    statuses[value] = (statuses[value] || 0) + 1;
  }
  return { pending: byPlatform, seen: statuses, platforms: [...platforms.keys()] };
}

// Прибирання застарілих карток. Якщо коментаря вже немає серед актуальних
// (відповіли деінде або він вийшов із вікна пошуку), картка втратила сенс:
// знімаємо з неї кнопки й помічаємо коментар як закритий. Інакше власникові
// довелося б тиснути «Пропустити» на кожній вручну.
export async function cleanupStale(options = {}) {
  const state = options.state || await readState();
  const chatId = options.chatId || ownerChatId();
  const cleared = {};

  for (const adapter of platforms.values()) {
    if (adapter.enabled && !adapter.enabled()) continue;
    const pending = Object.keys(state.drafts)
      .filter((key) => key.startsWith(`${adapter.key}:`));
    if (!pending.length) continue;

    const live = new Set((await adapter.fetch(options)).map((c) => c.id));
    for (const key of pending) {
      const commentId = key.slice(adapter.key.length + 1);
      if (live.has(commentId)) continue; // ще актуальний — лишаємо
      const draft = state.drafts[key];
      if (draft?.messageId) {
        await editMessageReplyMarkup(chatId, draft.messageId).catch(() => {});
      }
      delete state.drafts[key];
      state.seen[key] = 'skipped';
      cleared[adapter.key] = (cleared[adapter.key] || 0) + 1;
    }
  }

  await writeState(state);
  return { cleared, left: Object.keys(state.drafts).length };
}

// Знімає позначку «пропущено» з коментарів, які ЗАРАЗ у полі зору, щоб
// наступний прохід оцінив їх наново. Потрібно після зміни правил: те, що
// старий промт відкидав як «відповіді не потребує», за новим варте відповіді.
// Обмежено вікном пошуку, тож лавини не буде.
export async function rethinkSkipped(options = {}) {
  const state = options.state || await readState();
  const freed = {};
  for (const adapter of platforms.values()) {
    if (adapter.enabled && !adapter.enabled()) continue;
    for (const comment of await adapter.fetch(options)) {
      const key = `${adapter.key}:${comment.id}`;
      if (state.seen[key] !== 'skipped') continue;
      delete state.seen[key];
      freed[adapter.key] = (freed[adapter.key] || 0) + 1;
    }
  }
  await writeState(state);
  return freed;
}

// --- Спостерігач -------------------------------------------------------------

const WATCH_MS = Number(process.env.COMMENTS_POLL_MS) || 15 * 60 * 1000;
let watchTimer = null;

export function startCommentWatcher() {
  if (watchTimer || !platforms.size) return;
  const tick = async () => {
    try {
      const results = await checkAll();
      const notable = results.filter((r) => r.error || r.asked || r.skipped);
      if (notable.length) console.log('[comments]', JSON.stringify(notable));
    } catch (error) {
      console.error('[comments]', error.message);
    }
  };
  watchTimer = setInterval(tick, WATCH_MS);
  tick();
}
