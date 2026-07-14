// Українська озвучка. Два рушії з автоматичним фолбеком:
//   openai — OpenAI TTS (gpt-4o-mini-tts), живі інтонації, ~1 цент за відео;
//   edge   — Microsoft Edge TTS (безкоштовно, потрібен pip install edge-tts).
// Основний рушій задається TTS_ENGINE у check.yml; якщо він падає,
// автоматично пробується другий.
import { execFile } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';

// Відео триває 21.5 с — озвучка має влазити, інакше кінець обріжеться.
const MAX_AUDIO_SECONDS = 21.3;

// cedar і marin — нові голоси, які OpenAI рекомендує як найякісніші.
const OPENAI_VOICE = process.env.TTS_OPENAI_VOICE || 'cedar';
const EDGE_VOICE = process.env.TTS_VOICE || 'uk-UA-OstapNeural'; // жіночий: uk-UA-PolinaNeural
// Структура з openai.fm: окремі поля подачі, прості прямі риси.
const INSTRUCTIONS =
  process.env.TTS_INSTRUCTIONS ||
  `Voice: Confident charismatic Ukrainian male showman, host of a viral TikTok facts channel; commands attention like a seasoned TV presenter.
Language: Natural, native Ukrainian pronunciation with correct word stress; no foreign accent.
Tone: Bold and assertive with contagious excitement — he KNOWS this fact will blow your mind; zero hesitation, zero uncertainty.
Pacing: Energetic and driving; a punchy dramatic pause after the opening question and before the final call to action.
Emotion: Confident amazement; hit the numbers and comparisons hard, with a slight rise in intensity toward the conclusion.
Delivery: Strong steady projection from the very first word, like speaking to a big audience; every sentence lands as a statement, ends decisively — never trailing off; finish with a firm, magnetic call to subscribe.`;

export async function synthesizeVoiceover(text, outputPath) {
  const primary = process.env.TTS_ENGINE === 'edge' ? edgeTts : openaiTts;
  const fallback = primary === edgeTts ? openaiTts : edgeTts;
  try {
    return await primary(text, outputPath);
  } catch (error) {
    console.error(`Основний TTS не вдався (${primary.name}): ${error.message}`);
    return fallback(text, outputPath);
  }
}

async function openaiTts(text, outputPath, speed = 1.0) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Не задано OPENAI_API_KEY');
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: OPENAI_VOICE,
      input: text,
      instructions: INSTRUCTIONS,
      response_format: 'mp3',
      speed,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI TTS: HTTP ${response.status} ${await response.text()}`);
  }
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));

  // Якщо начитка довша за відео — один раз перечитуємо швидше.
  const duration = await audioDuration(outputPath);
  if (speed === 1.0 && duration > MAX_AUDIO_SECONDS) {
    const factor = Math.min(duration / (MAX_AUDIO_SECONDS - 0.3), 1.35);
    return openaiTts(text, outputPath, Number(factor.toFixed(2)));
  }
  return outputPath;
}

async function edgeTts(text, outputPath) {
  const textFile = `${outputPath}.txt`;
  await writeFile(textFile, text);
  const args = ['--voice', EDGE_VOICE, '--rate=+15%', '--file', textFile, '--write-media', outputPath];
  // Edge TTS ігнорує HTTPS_PROXY з оточення — передаємо явно, якщо задано.
  if (process.env.HTTPS_PROXY) args.unshift('--proxy', process.env.HTTPS_PROXY);
  try {
    await run('edge-tts', args);
  } finally {
    await unlink(textFile).catch(() => {});
  }
  return outputPath;
}

async function audioDuration(filePath) {
  const output = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return Number.parseFloat(output) || 0;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${command}: ${error.message.split('\n')[0]}`;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}
