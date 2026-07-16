// Перезбирає відео з матеріалів ОСТАННЬОЇ вдалої сесії (last-video/:
// 6 фото + сценарій + тема), збережених автоматично в produceVideo().
// Використання: попросити Клода перегенерувати відео (наприклад, після
// виправлення вимови слова) — жодного повторного надсилання фото
// власником не потрібно.
// Запуск: Actions → regenerate → Run workflow.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildSlideshow, mixAudio } from '../src/montage.js';
import { synthesizeVoiceover } from '../src/tts.js';
import { generateNarration, generatePostTexts } from '../src/openai.js';
import { ownerChatId, sendMessage, sendVideo } from '../src/telegram.js';

const DIR = 'last-video';
const theme = (await readFile(path.join(DIR, 'theme.txt'), 'utf8')).trim();
const script = (await readFile(path.join(DIR, 'script.txt'), 'utf8')).trim() || null;
const photos = [1, 2, 3, 4, 5, 6].map((i) => path.join(DIR, `${i}.jpg`));
const chatId = ownerChatId();

console.log(`Перегенерація: «${theme}»`);

await buildSlideshow(photos, '/tmp/regen-silent.mp4');
const narration = await generateNarration(theme, script);
await synthesizeVoiceover(narration, '/tmp/regen-voice.mp3');
await mixAudio('/tmp/regen-silent.mp4', '/tmp/regen-voice.mp3', '/tmp/regen-final.mp4');

const texts = await generatePostTexts(theme);

await sendVideo(chatId, '/tmp/regen-final.mp4');
await sendMessage(chatId, texts.title);
await sendMessage(chatId, `${texts.description}\n\n${texts.hashtags}`);
if (texts.music) {
  await sendMessage(chatId, `🎵 Музика (шукай у TikTok):\n${texts.music}`);
}
console.log('Перегенероване відео надіслано.');
