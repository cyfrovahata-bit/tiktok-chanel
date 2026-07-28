// Відповіді на коментарі під роликами YouTube — з підтвердженням власника.
//
// Навмисно НЕ автовідповідач. Бот лише готує варіант відповіді й надсилає його
// в Telegram із кнопками; публікує лише те, що власник схвалив. Причини дві:
// модель рано чи пізно відповість дурницю на провокацію, і це буде видно всім
// під роликом; а масові однотипні автовідповіді підпадають під правила YouTube
// про неавтентичну активність.
//
// Стан живе файлом на Drive поруч із рештою службових файлів: процес на Railway
// перезапускається будь-коли, а двічі відповісти на той самий коментар —
// найгірше, що тут може статися.
import { google } from 'googleapis';
import { youtubeAuth } from './google-auth.js';
import { drive } from './drive.js';
import { promptFolderId } from './kyiv.js';
import { sendMessage, ownerChatId, answerCallbackQuery, editMessageReplyMarkup } from './telegram.js';
import { chatOnce } from './openai.js';

const FILE_NAME = 'yt-comments.json';
const KEEP = 300;
const MAX_PER_RUN = Number(process.env.YT_COMMENTS_PER_RUN) || 5;
const SKIP = 'ПРОПУСТИТИ';

let api = null;
function youtube() {
  if (!api) api = google.youtube({ version: 'v3', auth: youtubeAuth() });
  return api;
}

// --- Стан на Drive -----------------------------------------------------------

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

export async function readState() {
  const id = await findFile();
  if (!id) return { seen: {}, drafts: {} };
  try {
    const res = await drive().files.get({ fileId: id, alt: 'media', supportsAllDrives: true });
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return { seen: data?.seen || {}, drafts: data?.drafts || {} };
  } catch {
    return { seen: {}, drafts: {} }; // побитий файл — краще почати заново, ніж упасти
  }
}

export async function writeState(state) {
  // Обрізаємо історію: пам'ятати треба лише те, що ще може повторитись у видачі.
  const entries = Object.entries(state.seen || {});
  const seen = Object.fromEntries(entries.slice(-KEEP));
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

// --- YouTube -----------------------------------------------------------------

async function channelId(client) {
  if (process.env.YOUTUBE_CHANNEL_ID) return process.env.YOUTUBE_CHANNEL_ID;
  const res = await client.channels.list({ part: ['id'], mine: true });
  const id = res.data?.items?.[0]?.id;
  if (!id) throw new Error('YouTube: токен не бачить жодного каналу');
  return id;
}

// Свіжі коментарі верхнього рівня з усіх роликів каналу.
export async function fetchComments(options = {}) {
  const client = options.client || youtube();
  const mine = options.channelId || await channelId(client);
  const res = await client.commentThreads.list({
    part: ['snippet'],
    allThreadsRelatedToChannelId: mine,
    order: 'time',
    maxResults: Number(options.maxResults) || 20,
    textFormat: 'plainText',
  });
  return (res.data?.items || []).map((item) => {
    const top = item.snippet?.topLevelComment;
    return {
      id: top?.id,
      text: top?.snippet?.textOriginal || '',
      author: top?.snippet?.authorDisplayName || '—',
      authorChannelId: top?.snippet?.authorChannelId?.value || '',
      videoId: item.snippet?.videoId || '',
      publishedAt: top?.snippet?.publishedAt || '',
    };
  }).filter((c) => c.id && c.authorChannelId !== mine); // свої ж відповіді пропускаємо
}

export async function publishReply(commentId, text, options = {}) {
  const client = options.client || youtube();
  const res = await client.comments.insert({
    part: ['snippet'],
    requestBody: { snippet: { parentId: commentId, textOriginal: String(text).trim() } },
  });
  return res.data?.id || null;
}

// --- Чернетка відповіді ------------------------------------------------------

export function draftPrompt(comment) {
  return [
    'Ти — автор українського каналу коротких пізнавальних роликів «Чи Ви Знали?».',
    'Напиши коротку відповідь на коментар глядача під роликом.',
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
  const answer = String(await ask(draftPrompt(comment))).trim();
  if (!answer || answer.toUpperCase().startsWith(SKIP)) return null;
  return answer.replace(/^["'«»]+|["'«»]+$/g, '').slice(0, 900);
}

// --- Telegram ----------------------------------------------------------------

function keyboard(commentId) {
  return {
    inline_keyboard: [[
      { text: '✅ Надіслати', callback_data: `ytc:s:${commentId}` },
      { text: '✏️ Змінити', callback_data: `ytc:e:${commentId}` },
      { text: '🚫 Пропустити', callback_data: `ytc:x:${commentId}` },
    ]],
  };
}

function card(comment, draft) {
  return [
    `💬 Коментар під роликом youtu.be/${comment.videoId}`,
    '',
    `${comment.author}:`,
    comment.text,
    '',
    'Відповідь від ШІ:',
    draft,
  ].join('\n');
}

// Один прохід: знайти нові коментарі, підготувати відповіді, надіслати на
// підтвердження. Повертає короткий підсумок для діагностики.
export async function checkComments(options = {}) {
  const state = options.state || await readState();
  const comments = await fetchComments(options);
  const fresh = comments.filter((c) => !state.seen[c.id]);
  if (!fresh.length) return { checked: comments.length, fresh: 0, asked: 0, skipped: 0 };

  const notify = options.notifyFn || sendMessage;
  const chatId = options.chatId || ownerChatId();
  let asked = 0;
  let skipped = 0;

  // Найстаріші першими, щоб відповіді йшли в порядку появи коментарів.
  for (const comment of fresh.reverse().slice(0, MAX_PER_RUN)) {
    let draft = null;
    try {
      draft = await draftReply(comment, options);
    } catch (error) {
      console.error('[yt-comments] чернетка:', error.message);
      continue; // спробуємо наступного разу
    }
    if (!draft) {
      state.seen[comment.id] = 'skipped';
      skipped += 1;
      continue;
    }
    const message = await notify(chatId, card(comment, draft), keyboard(comment.id));
    state.seen[comment.id] = 'pending';
    state.drafts[comment.id] = { text: draft, messageId: message?.message_id ?? null };
    asked += 1;
  }

  await writeState(state);
  return { checked: comments.length, fresh: fresh.length, asked, skipped };
}

// Періодична перевірка. Коментарі під роликами з'являються нечасто, тож
// заглядаємо раз на 15 хвилин — цього досить, щоб відповідь не виглядала
// запізнілою, і мало для квоти (запит гілок коштує 1 одиницю з 10 000 на добу).
const WATCH_MS = Number(process.env.YT_COMMENTS_POLL_MS) || 15 * 60 * 1000;
let watchTimer = null;

export function startCommentWatcher() {
  if (watchTimer || process.env.ENABLE_YT_COMMENTS !== '1') return;
  const tick = async () => {
    try {
      const result = await checkComments();
      if (result.asked || result.skipped) console.log('[yt-comments]', JSON.stringify(result));
    } catch (error) {
      console.error('[yt-comments]', error.message);
    }
  };
  watchTimer = setInterval(tick, WATCH_MS);
  tick();
}

// --- Обробка натискань і ручного тексту --------------------------------------

// Повертає true, якщо оновлення стосувалося коментарів (щоб цикл не шукав далі).
export async function handleCallback(callbackQuery, options = {}) {
  const data = String(callbackQuery?.data || '');
  if (!data.startsWith('ytc:')) return false;
  const [, action, commentId] = data.split(':');
  const chatId = ownerChatId();
  if (String(callbackQuery.from?.id) !== chatId) return true; // не власник — мовчки ігноруємо

  const state = options.state || await readState();
  const draft = state.drafts[commentId];
  const clear = async (note) => {
    delete state.drafts[commentId];
    await writeState(state);
    if (callbackQuery.message?.message_id) {
      await editMessageReplyMarkup(chatId, callbackQuery.message.message_id).catch(() => {});
    }
    await answerCallbackQuery(callbackQuery.id, note);
  };

  if (action === 'x') {
    state.seen[commentId] = 'skipped';
    await clear('Пропущено');
    return true;
  }
  if (action === 'e') {
    // Текст прийде окремим повідомленням — відповіддю на цю картку.
    await answerCallbackQuery(callbackQuery.id, 'Надішли свій текст відповіддю на це повідомлення');
    return true;
  }
  if (action === 's') {
    if (!draft) { await answerCallbackQuery(callbackQuery.id, 'Чернетку вже використано'); return true; }
    try {
      await publishReply(commentId, draft.text, options);
      state.seen[commentId] = 'sent';
      await clear('Відповідь опубліковано ✅');
    } catch (error) {
      await answerCallbackQuery(callbackQuery.id, `Не вдалося: ${error.message}`.slice(0, 190));
    }
    return true;
  }
  return true;
}

// Власник відповів на картку своїм текстом — публікуємо саме його.
export async function handleMessage(message, options = {}) {
  const replyTo = message?.reply_to_message?.message_id;
  const text = String(message?.text || '').trim();
  if (!replyTo || !text) return false;
  if (String(message.from?.id) !== ownerChatId()) return false;

  const state = options.state || await readState();
  const entry = Object.entries(state.drafts).find(([, d]) => d.messageId === replyTo);
  if (!entry) return false;
  const [commentId] = entry;

  const notify = options.notifyFn || sendMessage;
  try {
    await publishReply(commentId, text, options);
    state.seen[commentId] = 'sent';
    delete state.drafts[commentId];
    await writeState(state);
    await editMessageReplyMarkup(ownerChatId(), replyTo).catch(() => {});
    await notify(ownerChatId(), '✅ Твою відповідь опубліковано.');
  } catch (error) {
    await notify(ownerChatId(), `⚠️ Не вдалося опублікувати відповідь: ${error.message}`);
  }
  return true;
}
