// Українська озвучка. Три рушії з автоматичним фолбек-ланцюжком:
//   elevenlabs — ElevenLabs (найнатуральніший, потрібен ELEVENLABS_API_KEY);
//   openai     — OpenAI TTS (gpt-4o-mini-tts), живі інтонації, ~1 цент за відео;
//   edge       — Microsoft Edge TTS (безкоштовно, потрібен pip install edge-tts).
// Основний рушій задається TTS_ENGINE у check.yml; якщо він падає,
// автоматично пробуються наступні.
import { execFile } from 'node:child_process';
import { mkdtemp, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { slideStartTimes, slideSlotDurations } from './montage.js';

// Виклик передає РЕАЛЬНУ довжину відео (slideshowDuration під фактичну
// кількість слайдів). Голос має закінчуватися за END_MARGIN секунд до кінця
// відео: не впритул (щоб фінал не «різало»), але й не залишаючи довгої тиші.
const END_MARGIN = 0.6;
const DEFAULT_VIDEO_SECONDS = 21.5; // 6 слайдів — дефолт, якщо довжину не передано
const DEFAULT_TARGET_SECONDS = DEFAULT_VIDEO_SECONDS - END_MARGIN;

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
  // ElevenLabs v3 (Creative) інколи «ковтає» чи перекручує це слово
  // (напр. «питиписуйся») — воно ж у фіналі кожного відео, тож наголос
  // страхує вимову щоразу.
  ['підписуйся', 'підпи́суйся'],
  ['кишать', 'киша́ть'],
  // Психея — офіційна укр. назва астероїда 16 Psyche, наголос на «е».
  ['психею', 'психе́ю'],
  ['психеї', 'психе́ї'],
  ['психея', 'психе́я'],
  ['психе', 'психе́'],
  // підтвердити → підтве́рдили (наголос на «е», не на «и»).
  ['підтвердили', 'підтве́рдили'],
  // ElevenLabs ковтав початок після числа: «6 літрів» → «6 екрів».
  // Наголос змушує проартикулювати слово повністю.
  ['літрів', 'лі́трів'],
  ['літри', 'лі́три'],
  ['літра', 'лі́тра'],
  ['літрами', 'лі́трами'],
  // Числівники, де ElevenLabs ставив наголос не туди:
  // «дев'ять» читав як «дев'Я́ть» (наголос на «я») — норма де́в'ять.
  // Апостроф у різних варіантах (', ’, ʼ) — тому клас у регексі.
  ["дев['’ʼ]ять", "де́в'ять"],
  // «шістдесят» читав як «шістдесЯ́т/шістдесять» — власник хоче наголос на «е».
  ['шістдесят', 'шістде́сят'],
  // «двадцяти» вимовляв як «двадцятІ» (і в кінці) — наголос на кінцевому «и»
  // фіксує правильне «двадцяти́» (напр. «двадцяти́ тисячам»).
  ['двадцяти', 'двадцяти́'],
  // Спроба поставити акцент на «зна́ли» (наголос там і так правильний)
  // натомість зламала кінцівку «и» на «і» («зналі») — прибрано.
];

// Межі слова, безпечні для кирилиці (\b у JS orientується на [A-Za-z0-9_]
// і не працює з українськими літерами) — інакше, наприклад, коротше
// «психе» матчилося б і всередині «психею», даючи подвійний наголос.
// U+0301 (комбінований акут) теж у класі — інакше вже проставлений
// наголос не вважається «частиною слова», і коротше правило накладає
// другий акут поверх першого.
const CYRILLIC = 'а-яіїєґА-ЯІЇЄҐ\\u0301';

function fixPronunciation(text) {
  let result = text;
  // Довші фрази — першими: інакше коротше правило встигне спрацювати
  // всередині слова, яке мало б зловити довше правило цілком.
  const sorted = [...PRONUNCIATION_FIXES].sort((a, b) => b[0].length - a[0].length);
  for (const [word, fixed] of sorted) {
    const pattern = new RegExp(`(?<![${CYRILLIC}])${word}(?![${CYRILLIC}])`, 'gi');
    result = result.replace(pattern, (match) => matchCase(fixed, match));
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

// Прогін рушіїв із фолбеком (без підгонки часу).
async function runEngines(text, outputPath, targetSeconds) {
  const primary = ENGINES[process.env.TTS_ENGINE] ? process.env.TTS_ENGINE : 'openai';
  const order = [primary, ...Object.keys(ENGINES).filter((name) => name !== primary)];
  let lastError;
  for (const name of order) {
    try {
      await ENGINES[name](text, outputPath, targetSeconds);
      return;
    } catch (error) {
      lastError = error;
      console.error(`TTS ${name} не вдався: ${error.message}`);
    }
  }
  throw lastError;
}

// Головний вхід. Якщо передано slideCount і речень вистачає — синтезує озвучку
// З ПРИВ'ЯЗКОЮ ДО СЛАЙДІВ (кожне речення починається з початком свого слайда).
// Інакше — суцільна начитка, підігнана під довжину відео (старий шлях).
export async function synthesizeVoiceover(
  text,
  outputPath,
  videoSeconds = DEFAULT_VIDEO_SECONDS,
  slideCount = null,
) {
  text = fixPronunciation(text);
  const targetSeconds = videoSeconds - END_MARGIN;
  const sentences = slideCount ? splitSentences(text) : [];
  // Прив'язка можлива, лише коли речень не менше, ніж слайдів (інакше якісь
  // слайди лишились би без озвучки) — тоді відкат на суцільну начитку.
  if (slideCount && sentences.length >= slideCount) {
    try {
      await synthesizeAligned(groupSentences(sentences, slideCount), slideCount, outputPath);
      return outputPath;
    } catch (error) {
      // Прив'язка не критична: якщо щось пішло не так — не лишаємо відео без
      // звуку, а відкочуємось на суцільну начитку.
      console.error(`Прив'язка до слайдів не вдалась (${error.message}); суцільна начитка.`);
    }
  }
  await runEngines(text, outputPath, targetSeconds);
  await fitToVideo(outputPath, targetSeconds);
  return outputPath;
}

// Розбиває текст на речення (крапка/оклик/знак питання/трикрапка).
function splitSentences(text) {
  const matches = text.replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]+/g);
  return (matches || [text.trim()]).map((s) => s.trim()).filter(Boolean);
}

// Групує речення рівно в N груп (по слайдах), зберігаючи порядок: перші N-1
// слайдів — по реченню, останній забирає всі зайві (напр. подвійна кінцівка
// «питання + поглянь ще раз» лягає на фінальний слайд).
function groupSentences(sentences, n) {
  const groups = [];
  for (let i = 0; i < n - 1; i++) groups.push(sentences[i] || '');
  groups.push(sentences.slice(n - 1).join(' '));
  return groups;
}

// Синтезує кожну групу-речення окремо і ставить її на таймлайн так, щоб вона
// починалася з початком свого слайда (adelay), потім змішує (amix). Речення,
// яке не влазить у свій слот, локально пришвидшується; коротше — лишає
// природну паузу до наступного слайда (звідси відчуття синхрону з кадрами).
async function synthesizeAligned(groups, slideCount, outputPath) {
  const starts = slideStartTimes(slideCount);
  const slots = slideSlotDurations(slideCount);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tts-aligned-'));

  // 1) Синтезуємо кожне речення окремо й обрізаємо передню тишу.
  const clips = [];
  for (let i = 0; i < slideCount; i++) {
    const clipText = (groups[i] || '').trim();
    if (!clipText) continue;
    const clip = path.join(dir, `clip${i}.mp3`);
    await runEngines(clipText, clip, slots[i]);
    await trimSilence(clip);
    clips.push({ path: clip, slide: i });
  }
  if (clips.length === 0) throw new Error('Порожня начитка для всіх слайдів');

  // 2) ЄДИНИЙ темп для ВСІХ слайдів — щоб швидкість голосу не стрибала між
  // кадрами. Коефіцієнт = найбільше перевищення слота серед усіх речень
  // (тільки прискорення, стеля 1.6). Якщо всі влазять — 1.0 (без змін).
  // Підлога 1.3 — жвавий темп навіть на коротких репліках; стеля 1.6 —
  // верхня межа, щоб не перетнути у нерозбірливу скоромовку.
  let factor = 1.3;
  for (const clip of clips) {
    const duration = await audioDuration(clip.path);
    factor = Math.max(factor, duration / (slots[clip.slide] - 0.15));
  }
  factor = Math.min(factor, 1.6);
  console.log(`Прив'язка до слайдів: єдиний темп ${factor.toFixed(2)}× для всіх ${clips.length} реплік`);

  // 3) Застосовуємо той самий темп до кожного кліпу й ставимо на таймлайн.
  const inputs = [];
  const filters = [];
  let idx = 0;
  for (const clip of clips) {
    if (factor > 1.001) await applyTempo(clip.path, factor);
    inputs.push('-i', clip.path);
    const delayMs = Math.round(starts[clip.slide] * 1000);
    filters.push(`[${idx}:a]adelay=${delayMs}:all=1[a${idx}]`);
    idx++;
  }
  let filterComplex;
  let mapLabel;
  if (idx === 1) {
    filterComplex = filters[0];
    mapLabel = '[a0]';
  } else {
    const mixIns = Array.from({ length: idx }, (_, k) => `[a${k}]`).join('');
    filterComplex = `${filters.join(';')};${mixIns}amix=inputs=${idx}:normalize=0[out]`;
    mapLabel = '[out]';
  }
  await run('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', filterComplex,
    '-map', mapLabel,
    '-c:a', 'libmp3lame',
    outputPath,
  ]);
  return outputPath;
}

// Прибирає тишу з ОБОХ кінців кліпу: спереду — щоб слово стартувало точно на
// початку слайда; ззаду — щоб репліка не тягнулася паузою у чужий слот (це і
// скорочує кліп, тримаючи темп натуральним). Трюк: обрізати початок, розвернути,
// обрізати початок ще раз (=кінець), розвернути назад.
async function trimSilence(clip) {
  const out = `${clip}.trim.mp3`;
  const trim = 'silenceremove=start_periods=1:start_duration=0:start_threshold=-40dB';
  await run('ffmpeg', ['-y', '-i', clip, '-af', `${trim},areverse,${trim},areverse`, out]);
  await rename(out, clip);
}

// Застосовує заданий темп (atempo, тон зберігається) до кліпу — тим самим
// коефіцієнтом для всіх реплік, щоб швидкість між слайдами була однакова.
async function applyTempo(clip, factor) {
  const out = `${clip}.t.mp3`;
  await run('ffmpeg', ['-y', '-i', clip, '-filter:a', `atempo=${factor.toFixed(3)}`, out]);
  await rename(out, clip);
}

// Підганяє начитку під targetSeconds atempo'ом (тон зберігається): задовгу
// прискорює, щоб не різало фінал; закоротку СПОВІЛЬНЮЄ (розтягує) — це і темп
// робить спокійнішим, і прибирає довгу тишу в кінці відео.
async function fitToVideo(outputPath, targetSeconds = DEFAULT_TARGET_SECONDS) {
  const duration = await audioDuration(outputPath);
  // Дрібні відхилення не чіпаємо — зайвий перекодинг ні до чого.
  const TOLERANCE = 0.4;
  if (Math.abs(duration - targetSeconds) <= TOLERANCE) return;
  // <1 = сповільнити, >1 = прискорити. Стеля 1.7 (щоб довга начитка ~34 с
  // усе ж вмістилась), підлога 0.85 (нижче звучить неприродно тягуче).
  const factor = Math.max(0.85, Math.min(duration / targetSeconds, 1.7));
  const fitted = `${outputPath}.fit.mp3`;
  await run('ffmpeg', ['-y', '-i', outputPath, '-filter:a', `atempo=${factor.toFixed(3)}`, fitted]);
  await rename(fitted, outputPath);
  const verb = factor < 1 ? 'сповільнено' : 'прискорено';
  console.log(`Озвучку ${verb} в ${factor.toFixed(2)}× (була ${duration.toFixed(1)} с, ціль ${targetSeconds.toFixed(1)} с)`);
}

// ElevenLabs. За замовчуванням — модель Eleven v3 з аудіо-тегами
// ([excited], [whispers]...) у режимі Creative (stability 0.0): максимум
// живої гри голосом. Для старої Multilingual v2 — класичні налаштування
// розповідної начитки.
async function elevenLabsTts(text, outputPath, targetSeconds = DEFAULT_TARGET_SECONDS, retry) {
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
  if (!retry && !isV3 && duration > targetSeconds) {
    const factor = Math.min(duration / (targetSeconds - 0.3), 1.2);
    return elevenLabsTts(text, outputPath, targetSeconds, Number(factor.toFixed(2)));
  }
  return outputPath;
}

async function openaiTts(text, outputPath, targetSeconds = DEFAULT_TARGET_SECONDS, speed = 1.0) {
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
  if (speed === 1.0 && duration > targetSeconds) {
    const factor = Math.min(duration / (targetSeconds - 0.3), 1.35);
    return openaiTts(text, outputPath, targetSeconds, Number(factor.toFixed(2)));
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
