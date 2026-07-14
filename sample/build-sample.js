// Тимчасовий скрипт: збирає зразок відео про колібрі з озвучкою OpenAI TTS
// і надсилає власнику в Telegram. Запускається воркфлоу sample.yml вручну.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { buildSlideshow, mixAudio } from '../src/montage.js';
import { synthesizeVoiceover } from '../src/tts.js';
import { ownerChatId, sendMessage, sendVideo } from '../src/telegram.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const photos = [1, 2, 3, 4, 5, 6].map((i) => path.join(dir, `${i}.jpg`));
const narration = (await readFile(path.join(dir, 'narration.txt'), 'utf8')).trim();

await buildSlideshow(photos, '/tmp/silent.mp4');
await synthesizeVoiceover(narration, '/tmp/voice.mp3');
await mixAudio('/tmp/silent.mp4', '/tmp/voice.mp3', '/tmp/sample.mp4');
await sendVideo(ownerChatId(), '/tmp/sample.mp4');
await sendMessage(ownerChatId(), '🎙 Зразок нового голосу — OpenAI TTS (ash)');
console.log('Зразок надіслано');
