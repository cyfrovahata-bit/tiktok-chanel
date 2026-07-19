// Перезбирає відео з матеріалів ОСТАННЬОЇ вдалої сесії (last-video/:
// 6 фото + сценарій + тема), збережених автоматично в produceVideo().
// Використання: попросити Клода перегенерувати відео (наприклад, після
// виправлення вимови слова) — жодного повторного надсилання фото
// власником не потрібно.
// Запуск: Actions → regenerate → Run workflow.
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { buildSlideshow, mixAudio, slideshowDuration } from '../src/montage.js';
import { synthesizeVoiceover } from '../src/tts.js';
import { generateNarration, generatePostTexts } from '../src/openai.js';
import { ownerChatId, sendMessage, sendVideo } from '../src/telegram.js';

const DIR = 'last-video';
const theme = (await readFile(path.join(DIR, 'theme.txt'), 'utf8')).trim();
const script = (await readFile(path.join(DIR, 'script.txt'), 'utf8')).trim() || null;
// Кількість фото гнучка (5–8) — беремо всі 1.jpg, 2.jpg… у знімку по порядку.
const files = await readdir(DIR);
const photos = files
  .filter((name) => /^\d+\.jpg$/.test(name))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
  .map((name) => path.join(DIR, name));
const chatId = ownerChatId();

console.log(`Перегенерація: «${theme}» (${photos.length} слайдів)`);

await buildSlideshow(photos, '/tmp/regen-silent.mp4');
const narration = await generateNarration(theme, script, photos.length);
console.log(`Начитка (${narration.trim().split(/\s+/).length} слів):\n${narration}\n`);
await synthesizeVoiceover(narration, '/tmp/regen-voice.mp3', slideshowDuration(photos.length));
await mixAudio('/tmp/regen-silent.mp4', '/tmp/regen-voice.mp3', '/tmp/regen-final.mp4');

const texts = await generatePostTexts(theme);

await sendVideo(chatId, '/tmp/regen-final.mp4');
await sendMessage(chatId, texts.title);
await sendMessage(chatId, `${texts.description}\n\n${texts.hashtags}`);
if (texts.music) {
  await sendMessage(chatId, `🎵 Музика (шукай у TikTok):\n${texts.music}`);
}
console.log('Перегенероване відео надіслано.');
