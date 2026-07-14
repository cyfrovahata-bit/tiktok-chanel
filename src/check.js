// Точка входу воркфлоу check: читає оновлення Telegram, обробляє кнопку
// «Інша тема» і фото; коли фото 6 — монтує відео і шле 4 повідомлення-результати.
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateNarration, generatePostTexts } from './openai.js';
import { buildSlideshow, mixAudio } from './montage.js';
import { synthesizeVoiceover } from './tts.js';
import { emptySession, markTheme, readState, saveState } from './state.js';
import { startNewSession } from './themes.js';
import {
  answerCallbackQuery,
  downloadFile,
  editMessageReplyMarkup,
  getFile,
  getUpdates,
  ownerChatId,
  sendMessage,
  sendVideo,
} from './telegram.js';

const PHOTOS_NEEDED = 6;

async function handleCallback(state, callbackQuery) {
  const chatId = ownerChatId();
  // Єдиний дозволений користувач — власник.
  if (String(callbackQuery.from?.id) !== chatId) return;
  if (callbackQuery.data !== 'other_theme') {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }
  // Кнопка зі старого промпта (після заміни теми) — просто гасимо «годинник».
  if (callbackQuery.message?.message_id !== state.session.prompt_message_id) {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }
  if (state.session.photos.length > 0) {
    await answerCallbackQuery(callbackQuery.id, 'Фото вже отримано');
    return;
  }

  await answerCallbackQuery(callbackQuery.id);
  try {
    await editMessageReplyMarkup(chatId, state.session.prompt_message_id);
  } catch (error) {
    console.error('Не вдалося прибрати кнопку зі старого промпта:', error.message);
  }
  markTheme(state, state.session.theme, 'rejected');
  await startNewSession(state);
}

function collectPhoto(state, message) {
  if (String(message.chat?.id) !== ownerChatId()) return;
  if (!Array.isArray(message.photo) || message.photo.length === 0) return;
  // Фото альбому (media_group) приходять окремими update'ами — просто
  // накопичуємо file_id найбільшого розміру в порядку отримання.
  const largest = message.photo.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  state.session.photos.push(largest.file_id);
}

async function produceVideo(state) {
  const chatId = ownerChatId();
  const theme = state.session.theme;
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'slideshow-'));
  const outputPath = path.join(workDir, 'out.mp4');

  try {
    const photoPaths = [];
    for (const [index, fileId] of state.session.photos.slice(0, PHOTOS_NEEDED).entries()) {
      const remotePath = await getFile(fileId);
      const localPath = path.join(workDir, `photo-${index}${path.extname(remotePath) || '.jpg'}`);
      await downloadFile(remotePath, localPath);
      photoPaths.push(localPath);
    }
    await buildSlideshow(photoPaths, outputPath);
  } catch (error) {
    if (error.stderr) console.error(error.stderr);
    console.error(error);
    await sendMessage(chatId, `Помилка монтажу: ${error.message}`);
    // Сесія лишається активною: власник може дослати фото, наступний запуск повторить монтаж.
    await saveState(state, 'check: помилка монтажу, сесія активна');
    process.exitCode = 1;
    return;
  }

  // Озвучка вимкнена, поки в check.yml не задано ENABLE_TTS: "1".
  // Будь-яка помилка озвучки не блокує публікацію — відео піде без звуку.
  let finalVideoPath = outputPath;
  if (process.env.ENABLE_TTS === '1') {
    try {
      const narration = await generateNarration(theme);
      const voicePath = await synthesizeVoiceover(narration, path.join(workDir, 'voice.mp3'));
      finalVideoPath = await mixAudio(outputPath, voicePath, path.join(workDir, 'out-voiced.mp4'));
    } catch (error) {
      if (error.stderr) console.error(error.stderr);
      console.error('Озвучка не вдалася, надсилаю відео без звуку:', error);
    }
  }

  let texts = null;
  try {
    texts = await generatePostTexts(theme);
  } catch (error) {
    console.error('Не вдалося згенерувати тексти публікації:', error);
  }

  // Результат — рівно 4 повідомлення без підписів і префіксів.
  await sendVideo(chatId, finalVideoPath);
  if (texts) {
    await sendMessage(chatId, texts.title);
    await sendMessage(chatId, `${texts.description}\n\n${texts.hashtags}`);
    if (texts.music) {
      await sendMessage(chatId, `🎵 Музика (шукай у TikTok):\n${texts.music}`);
    }
  } else {
    await sendMessage(chatId, 'тексти не згенеровано');
  }

  markTheme(state, theme, 'done');
  state.session = emptySession();
  await saveState(state, `check: відео змонтовано, тема «${theme}» закрита`);
}

async function main() {
  const state = await readState();
  if (!state.session.active) return;

  if (Date.parse(state.session.window_end) < Date.now()) {
    markTheme(state, state.session.theme, 'skipped');
    state.session = emptySession();
    await sendMessage(ownerChatId(), 'Вікно минуло, фото можна прислати з наступною темою');
    await saveState(state, 'check: вікно минуло, сесію закрито');
    return;
  }

  const updates = await getUpdates(state.last_update_id + 1);
  for (const update of updates) {
    state.last_update_id = Math.max(state.last_update_id, update.update_id);
    if (update.callback_query) {
      await handleCallback(state, update.callback_query);
    } else if (update.message) {
      collectPhoto(state, update.message);
    }
  }

  if (state.session.photos.length >= PHOTOS_NEEDED) {
    await produceVideo(state);
  } else {
    await saveState(state, 'check: оновлення оброблено');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
