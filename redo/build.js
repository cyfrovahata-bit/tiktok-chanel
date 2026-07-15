// Одноразовий редо: коралове відео змонтувалось з чужими (морська зірка)
// фото через баг офсету getUpdates. Тут той самий продакшн-конвеєр,
// що й produceVideo() у check.js, але з правильними локальними фото.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { buildSlideshow, mixAudio } from '../src/montage.js';
import { synthesizeVoiceover } from '../src/tts.js';
import { generateNarration, generatePostTexts } from '../src/openai.js';
import { ownerChatId, sendMessage, sendVideo } from '../src/telegram.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const THEME =
  'Суміш води з океану та води з річок створює особливий вид води, який підтримує життя у коралових рифах.';
const script = (await readFile(path.join(dir, 'script.txt'), 'utf8')).trim();
const photos = [1, 2, 3, 4, 5, 6].map((i) => path.join(dir, `${i}.jpg`));
const chatId = ownerChatId();

await buildSlideshow(photos, '/tmp/redo-silent.mp4');
const narration = await generateNarration(THEME, script);
await synthesizeVoiceover(narration, '/tmp/redo-voice.mp3');
await mixAudio('/tmp/redo-silent.mp4', '/tmp/redo-voice.mp3', '/tmp/redo-final.mp4');

const texts = await generatePostTexts(THEME);

await sendVideo(chatId, '/tmp/redo-final.mp4');
await sendMessage(chatId, texts.title);
await sendMessage(chatId, `${texts.description}\n\n${texts.hashtags}`);
if (texts.music) {
  await sendMessage(chatId, `🎵 Музика (шукай у TikTok):\n${texts.music}`);
}
console.log('Перезмонтоване коралове відео надіслано.');
