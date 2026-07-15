// Точка входу воркфлоу check: читає оновлення Telegram, обробляє кнопку
// «Інша тема» і фото; коли фото 6 — монтує відео і шле 4 повідомлення-результати.
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateNarration, generatePostTexts } from './openai.js';
import { buildSlideshow, mixAudio } from './montage.js';
import { synthesizeVoiceover } from './tts.js';
import { currentThemeSlot, emptySession, markTheme, readState, saveState } from './state.js';
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
const LAST_VIDEO_DIR = 'last-video';

// Знімок матеріалів останнього змонтованого відео (фото + сценарій + тема) —
// дозволяє scripts/regenerate.js перезібрати відео (наприклад, після
// виправлення вимови) без повторного надсилання фото власником.
async function saveLastVideoSnapshot(photoPaths, theme, script) {
  await mkdir(LAST_VIDEO_DIR, { recursive: true });
  for (const [index, photoPath] of photoPaths.entries()) {
    await copyFile(photoPath, path.join(LAST_VIDEO_DIR, `${index + 1}.jpg`));
  }
  await writeFile(path.join(LAST_VIDEO_DIR, 'theme.txt'), theme);
  await writeFile(path.join(LAST_VIDEO_DIR, 'script.txt'), script || '');
}

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

function collectMessage(state, message) {
  if (String(message.chat?.id) !== ownerChatId()) return;
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    // Фото альбому (media_group) приходять окремими update'ами — просто
    // накопичуємо file_id найбільшого розміру в порядку отримання.
    const largest = message.photo.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
    state.session.photos.push(largest.file_id);
  } else if (typeof message.text === 'string' && message.text.trim()) {
    // Текст від власника — сценарій слайдів від ChatGPT, основа озвучки.
    state.session.script = message.text.trim();
  }
}

async function produceVideo(state) {
  const chatId = ownerChatId();
  const theme = state.session.theme;
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'slideshow-'));
  const outputPath = path.join(workDir, 'out.mp4');

  let photoPaths = [];
  try {
    // Останні 6, не перші: якщо в чергу оновлень потрапив «хвіст» зі
    // старої сесії (наприклад, після збою offset), найсвіжіші фото
    // від власника мають пріоритет над випадково причепленими старими.
    for (const [index, fileId] of state.session.photos.slice(-PHOTOS_NEEDED).entries()) {
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

  // Знімок для можливої перегенерації (scripts/regenerate.js) — власник
  // може попросити перезібрати відео (виправити слово, тощо) без
  // повторного надсилання фото. Некритично: помилка тут не має нічого зупиняти.
  try {
    await saveLastVideoSnapshot(photoPaths, theme, state.session.script);
  } catch (error) {
    console.error('Не вдалося зберегти знімок для перегенерації:', error);
  }

  // Озвучка вимкнена, поки в check.yml не задано ENABLE_TTS: "1".
  // Будь-яка помилка озвучки не блокує публікацію — відео піде без звуку.
  let finalVideoPath = outputPath;
  if (process.env.ENABLE_TTS === '1') {
    try {
      const narration = await generateNarration(theme, state.session.script);
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
  // Мережевий збій саме тут (Telegram API) не має «з'їдати» вже готове
  // відео і озвучку — сесія лишається активною, наступний запуск
  // повторить відправку без повторного монтажу/TTS/OpenAI-викликів.
  try {
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
  } catch (error) {
    console.error('Не вдалося надіслати результат (мережевий збій?):', error);
    await saveState(state, 'check: відео готове, надсилання не вдалось — повторю наступного разу', [
      LAST_VIDEO_DIR,
    ]);
    process.exitCode = 1;
    return;
  }

  markTheme(state, theme, 'done');
  state.session = emptySession();
  await saveState(state, `check: відео змонтовано, тема «${theme}» закрита`, [LAST_VIDEO_DIR]);
}

async function main() {
  const state = await readState();
  try {
    await run(state);
  } catch (error) {
    // Гарантія: навіть якщо щось усередині впало неочікувано (мережа,
    // баг), offset і будь-які часткові зміни стану, накопичені в пам'яті
    // до падіння, все одно зберігаються — інакше зіпсоване оновлення
    // блокувало б увесь конвеєр і падало б знову на кожному наступному
    // запуску назавжди.
    console.error(error);
    await saveState(state, 'check: аварійне збереження стану після помилки').catch((saveError) => {
      console.error('Не вдалося зберегти стан після помилки:', saveError);
    });
    process.exitCode = 1;
  }
}

async function run(state) {
  if (!state.session.active) {
    // Самолікування: GitHub часто дропає планові запуски themes.
    // Якщо триває слот теми (10:00–12:00 чи 18:00–20:00 Київ), а тему
    // ще не надіслано — надсилаємо її звідси.
    const slot = currentThemeSlot();
    if (slot && state.last_theme_slot !== slot) {
      const theme = await startNewSession(state);
      await saveState(state, `check: добрано пропущену тему «${theme}»`);
    }
    return;
  }

  if (Date.parse(state.session.window_end) < Date.now()) {
    markTheme(state, state.session.theme, 'skipped');
    state.session = emptySession();
    await sendMessage(ownerChatId(), 'Вікно минуло, фото можна прислати з наступною темою');
    await saveState(state, 'check: вікно минуло, сесію закрито');
    return;
  }

  const photosBefore = state.session.photos.length;
  const hadScript = Boolean(state.session.script);

  const updates = await getUpdates(state.last_update_id + 1);
  for (const update of updates) {
    state.last_update_id = Math.max(state.last_update_id, update.update_id);
    try {
      if (update.callback_query) {
        await handleCallback(state, update.callback_query);
      } else if (update.message) {
        collectMessage(state, update.message);
      }
    } catch (error) {
      // Одне «зіпсоване» оновлення (наприклад, протермінований callback_query)
      // не має блокувати решту черги назавжди: offset уже посунуто вище,
      // і main() внизу гарантовано збереже стан — інакше цей самий update
      // повторювався б і падав би на кожному наступному запуску.
      console.error(`Update ${update.update_id} не оброблено:`, error.message);
    }
  }

  // Монтаж стартує лише коли є ОБИДВІ частини: сценарій і 6 фото.
  // Інакше запуск міг би влучити між повідомленнями і згенерувати
  // відео без озвучки за сценарієм.
  const photosReady = state.session.photos.length >= PHOTOS_NEEDED;
  const scriptReady = Boolean(state.session.script);
  if (photosReady && scriptReady) {
    await produceVideo(state);
    return;
  }

  // Підказуємо, чого ще бракує — лише коли щось нове прийшло цим запуском.
  if (photosReady && !scriptReady && state.session.photos.length > photosBefore) {
    await sendMessage(ownerChatId(), '📸 6 фото отримано! Тепер надішліть текст сценарію — і я змонтую відео.');
  } else if (scriptReady && !hadScript && !photosReady) {
    await sendMessage(
      ownerChatId(),
      `📝 Сценарій отримано! Чекаю 6 фото (наразі ${state.session.photos.length}).`,
    );
  }
  await saveState(state, 'check: оновлення оброблено');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
