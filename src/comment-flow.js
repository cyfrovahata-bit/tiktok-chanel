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
    `- якщо коментар образливий, провокативний, спам або відповіді не потребує — поверни рівно слово ${SKIP};`,
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

function keyboard(platformKey, commentId) {
  const tail = `${platformKey}:${commentId}`;
  return {
    inline_keyboard: [[
      { text: '✅ Надіслати', callback_data: `c:s:${tail}` },
      { text: '✏️ Змінити', callback_data: `c:e:${tail}` },
      { text: '🚫 Пропустити', callback_data: `c:x:${tail}` },
    ]],
  };
}

function card(adapter, comment, draft) {
  return [
    `${adapter.icon} Коментар · ${adapter.label}`,
    adapter.link(comment),
    '',
    `${comment.author}:`,
    comment.text,
    '',
    'Відповідь від ШІ:',
    draft,
  ].filter((line) => line !== null).join('\n');
}

// --- Один прохід -------------------------------------------------------------

export async function checkPlatform(adapter, options = {}) {
  const state = options.state || await readState();
  const comments = await adapter.fetch(options);
  const fresh = comments.filter((c) => !state.seen[`${adapter.key}:${c.id}`]);
  const result = { platform: adapter.key, checked: comments.length, fresh: fresh.length, asked: 0, skipped: 0 };
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
    if (!draft) {
      state.seen[key] = 'skipped';
      result.skipped += 1;
      continue;
    }
    const message = await notify(chatId, card(adapter, comment, draft), keyboard(adapter.key, comment.id));
    state.seen[key] = 'pending';
    state.drafts[key] = { text: draft, messageId: message?.message_id ?? null };
    result.asked += 1;
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

export async function handleCallback(callbackQuery, options = {}) {
  const data = String(callbackQuery?.data || '');
  if (!data.startsWith('c:')) return false;
  const [, action, platformKey, ...rest] = data.split(':');
  const commentId = rest.join(':'); // id інколи містить двокрапку (Facebook)
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
    if (!draft) { await answerCallbackQuery(callbackQuery.id, 'Чернетку вже використано'); return true; }
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
