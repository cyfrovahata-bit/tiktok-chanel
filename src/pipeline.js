// Спільне ядро складання відео — платформо-незалежне (ні Telegram, ні веб).
// Оркеструє вже наявні модулі (montage, tts, openai). Використовується
// веб-панеллю (web/server.js). Старий Telegram-конвеєр не залежав
// від цього файлу — його робочий шлях лишається недоторканим.
//
// Ідея: одна функція бере готові фото + тему + (необов'язково) сценарій
// слайдів і повертає шлях до готового відео та тексти публікації —
// рівно те, що робив produceVideo() старого конвеєра, але без прив'язки до
// способу доставки (бот чи сайт).
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { buildSlideshow, mixAudio, slideshowDuration } from './montage.js';
import { coverTimestampMs } from './captions.js';
import { synthesizeVoiceover } from './tts.js';
import { generateNarration, generatePostTexts } from './openai.js';
import { splitScriptLines } from './archive.js';

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

  // Рядки script.txt (по рядку на слайд) — ЄДИНЕ джерело і тексту, і озвучки.
  // Бот НЕ генерує/не переформульовує текст: голос читає САМЕ ці рядки, а вони
  // ж накладаються субтитрами. Один рядок = один JPG; інакше зрозуміла помилка.
  let captionLines = null;
  if (script) {
    const lines = splitScriptLines(script);
    if (lines.length !== photoPaths.length) {
      // Показуємо, що саме лежить у файлі: інакше «1 рядок замість 8» нічого
      // не пояснює й доводиться качати архів руками.
      const preview = String(script).replace(/\s+/g, ' ').trim().slice(0, 180);
      throw new Error(
        `Рядків у script.txt (${lines.length}) не дорівнює кількості фото (${photoPaths.length}). `
        + 'Архів має містити рівно по рядку тексту на кожен JPG. '
        + `Початок файлу: «${preview}${preview.length >= 180 ? '…' : ''}»`,
      );
    }
    captionLines = lines;
  }

  // Озвучка ПЕРЕД монтажем: у режимі прив'язки повертає тривалості слайдів,
  // під які монтується відео.
  let voicePath = null;
  let slideDurations = null;
  if (withVoice) {
    try {
      const slideCount = photoPaths.length;
      const videoSeconds = slideshowDuration(slideCount);
      const voiceOut = path.join(workDir, 'voice.mp3');
      let result;
      if (captionLines) {
        // Голос читає рядки файлу ЯК Є (без OpenAI-генерації тексту).
        result = await synthesizeVoiceover(
          captionLines.join(' '), voiceOut, videoSeconds, captionLines.length, captionLines,
        );
      } else {
        // Легасі-фолбек (немає script.txt): начитка з теми.
        const narration = await generateNarration(theme, null, slideCount);
        result = await synthesizeVoiceover(narration, voiceOut, videoSeconds, slideCount);
      }
      voicePath = result.voicePath;
      slideDurations = result.slideDurations;
    } catch (error) {
      // Озвучка не критична — відео піде без звуку (та сама політика, що в боті).
      console.error('Озвучка не вдалася, відео без звуку:', error.message);
    }
  }

  await buildSlideshow(photoPaths, silentPath, slideDurations ?? photoPaths.length, captionLines);
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

  // Мітка обкладинки для сітки профілю — рахується тут, бо лише на цьому
  // етапі є і рядки, і фактичні тривалості слайдів. Далі вона їде в
  // appProperties ролика й доживає до публікації.
  const coverMs = slideDurations ? coverTimestampMs(captionLines, slideDurations) : null;
  return { videoPath, texts, coverMs };
}
