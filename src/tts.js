// Українська озвучка. Три рушії з автоматичним фолбек-ланцюжком:
//   elevenlabs — ElevenLabs (найнатуральніший, потрібен ELEVENLABS_API_KEY);
//   openai     — OpenAI TTS (gpt-4o-mini-tts), живі інтонації, ~1 цент за відео;
//   edge       — Microsoft Edge TTS (безкоштовно, потрібен pip install edge-tts).
// Основний рушій задається TTS_ENGINE у check.yml; якщо він падає,
// автоматично пробуються наступні.
import { execFile } from 'node:child_process';
import { rename, unlink, writeFile } from 'node:fs/promises';

// Відео триває 21.5 с. Цільова довжина озвучки — до 20 с: голос має
// закінчитися трохи раніше за відео і не обганяти слайди.
const MAX_AUDIO_SECONDS = 20.0;

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

const ENGINES = {
  get elevenlabs() { return elevenLabsTts; },
  get openai() { return openaiTts; },
  get edge() { return edgeTts; },
};

// Словничок наголосів: слова, де TTS системно помиляється. Наголошена
// голосна позначається комбінованим акутом (U+0301) — моделі його поважають.
// Помітили нове слово з кривим наголосом — додайте пару сюди.
const PRONUNCIATION_FIXES = [
  ['колібрі', 'колі́брі'],
];

function fixPronunciation(text) {
  let result = text;
  for (const [word, fixed] of PRONUNCIATION_FIXES) {
    result = result.replace(new RegExp(word, 'gi'), (match) => matchCase(fixed, match));
  }
  return result;
}

function matchCase(replacement, original) {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export async function synthesizeVoiceover(text, outputPath) {
  text = fixPronunciation(text);
  const primary = ENGINES[process.env.TTS_ENGINE] ? process.env.TTS_ENGINE : 'openai';
  const order = [primary, ...Object.keys(ENGINES).filter((name) => name !== primary)];
  let lastError;
  for (const name of order) {
    try {
      await ENGINES[name](text, outputPath);
      // Фінальна гарантія синхрону: якщо начитка довша за відео —
      // прискорюємо її atempo (без зміни тону) рівно під довжину відео.
      await fitToVideo(outputPath);
      return outputPath;
    } catch (error) {
      lastError = error;
      console.error(`TTS ${name} не вдався: ${error.message}`);
    }
  }
  throw lastError;
}

async function fitToVideo(outputPath) {
  const duration = await audioDuration(outputPath);
  if (duration <= MAX_AUDIO_SECONDS) return;
  // Обмеження 1.2: сильніше прискорення звучить заметушливо.
  const factor = Math.min(duration / (MAX_AUDIO_SECONDS - 0.2), 1.2);
  const fitted = `${outputPath}.fit.mp3`;
  await run('ffmpeg', ['-y', '-i', outputPath, '-filter:a', `atempo=${factor.toFixed(3)}`, fitted]);
  await rename(fitted, outputPath);
  console.log(`Озвучка прискорена в ${factor.toFixed(2)} раза (була ${duration.toFixed(1)} с)`);
}

// ElevenLabs. За замовчуванням — модель Eleven v3 з аудіо-тегами
// ([excited], [whispers]...) у режимі Creative (stability 0.0): максимум
// живої гри голосом. Для старої Multilingual v2 — класичні налаштування
// розповідної начитки.
async function elevenLabsTts(text, outputPath, retry) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Не задано ELEVENLABS_API_KEY');
  const voiceId = process.env.TTS_ELEVEN_VOICE_ID || 'N2lVS1w4EtoT3dr4eOWO'; // Callum — характерний, не заїжджений
  const modelId = process.env.TTS_ELEVEN_MODEL || 'eleven_v3';
  const isV3 = modelId.startsWith('eleven_v3');
  const voiceSettings = isV3
    ? { stability: 0.0, use_speaker_boost: true } // 0.0 = Creative
    : { stability: 0.45, similarity_boost: 0.8, style: 0.4, use_speaker_boost: true, ...(retry ? { speed: retry } : {}) };
  // v2-моделі читають теги вголос — прибираємо їх.
  const input = isV3 ? text : text.replace(/\[[a-z ]+\]/gi, '').replace(/ {2,}/g, ' ').trim();
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: input, model_id: modelId, voice_settings: voiceSettings }),
    },
  );
  if (!response.ok) {
    throw new Error(`ElevenLabs: HTTP ${response.status} ${await response.text()}`);
  }
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));

  // v2 при задовгій начитці перечитує швидше (природніше за atempo);
  // для v3 параметра швидкості немає — підганяння зробить fitToVideo.
  const duration = await audioDuration(outputPath);
  if (!retry && !isV3 && duration > MAX_AUDIO_SECONDS) {
    const factor = Math.min(duration / (MAX_AUDIO_SECONDS - 0.3), 1.2);
    return elevenLabsTts(text, outputPath, Number(factor.toFixed(2)));
  }
  return outputPath;
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
