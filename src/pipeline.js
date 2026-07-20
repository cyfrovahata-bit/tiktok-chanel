// Спільне ядро складання відео — платформо-незалежне (ні Telegram, ні веб).
// Оркеструє вже наявні модулі (montage, tts, openai). Використовується
// веб-панеллю (web/server.js). Telegram-конвеєр (check.js) поки НЕ залежить
// від цього файлу — його робочий шлях лишається недоторканим.
//
// Ідея: одна функція бере готові фото + тему + (необов'язково) сценарій
// слайдів і повертає шлях до готового відео та тексти публікації —
// рівно те, що робить produceVideo() у check.js, але без прив'язки до
// способу доставки (бот чи сайт).
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { buildSlideshow, mixAudio, slideshowDuration } from './montage.js';
import { synthesizeVoiceover } from './tts.js';
import { generateNarration, generatePostTexts } from './openai.js';

// Складає відео з фото + тексти публікації.
//   photoPaths — локальні шляхи до 6 фото (у порядку слайдів);
//   theme      — рядок теми;
//   script     — сценарій слайдів від ChatGPT (основа озвучки) або null;
//   withVoice  — чи накладати озвучку (за замовчуванням — як у продакшні).
// Повертає { videoPath, texts } — тексти можуть бути null, якщо OpenAI впав
// (відео важливіше за підпис, як і в боті).
export async function assembleVideo({ photoPaths, theme, script = null, withVoice = true, withTexts = true }) {
  if (!Array.isArray(photoPaths) || photoPaths.length < 2) {
    throw new Error(`Для монтажу треба щонайменше 2 фото, отримано ${photoPaths?.length ?? 0}`);
  }
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'webvideo-'));
  const silentPath = path.join(workDir, 'silent.mp4');

  // Озвучка ПЕРЕД монтажем: у режимі прив'язки вона повертає тривалості
  // слайдів, під які монтується відео.
  let voicePath = null;
  let slideDurations = null;
  if (withVoice) {
    try {
      const slideCount = photoPaths.length;
      const videoSeconds = slideshowDuration(slideCount);
      const narration = await generateNarration(theme, script, slideCount);
      const result = await synthesizeVoiceover(
        narration, path.join(workDir, 'voice.mp3'), videoSeconds, slideCount,
      );
      voicePath = result.voicePath;
      slideDurations = result.slideDurations;
    } catch (error) {
      // Озвучка не критична — відео піде без звуку (та сама політика, що в боті).
      console.error('Озвучка не вдалася, відео без звуку:', error.message);
    }
  }

  await buildSlideshow(photoPaths, silentPath, slideDurations ?? photoPaths.length);
  let videoPath = silentPath;
  if (voicePath) {
    try {
      videoPath = await mixAudio(silentPath, voicePath, path.join(workDir, 'voiced.mp4'));
    } catch (error) {
      console.error('Не вдалося накласти звук, відео без нього:', error.message);
    }
  }

  // Тексти публікації потрібні старому потоку; у новому (Google Sheet) назва
  // й опис беруться з таблиці, тож OpenAI-виклик пропускаємо (withTexts=false).
  let texts = null;
  if (withTexts) {
    try {
      texts = await generatePostTexts(theme);
    } catch (error) {
      console.error('Не вдалося згенерувати тексти публікації:', error.message);
    }
  }

  return { videoPath, texts };
}
