// Тестер голосів: збирає зразок відео про колібрі з обраним голосом
// і надсилає власнику в Telegram. Запуск: Actions → sample → Run workflow.
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

const voiceLabel =
  process.env.TTS_ENGINE === 'edge'
    ? `edge / ${process.env.TTS_VOICE || 'uk-UA-OstapNeural'}`
    : `openai / ${process.env.TTS_OPENAI_VOICE || 'cedar'}`;
await sendMessage(ownerChatId(), `🎙 Зразок голосу: ${voiceLabel}`);
console.log(`Зразок надіслано (${voiceLabel})`);
