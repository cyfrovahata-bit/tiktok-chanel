// Ядро довгої добірки: перезбирає готові епізоди з їхніх архівів і склеює
// в один файл. Використовується і CLI-скриптом, і міні-застосунком.
//
// «Чистий шлях»: не ріжемо готові MP4 наосліп, а збираємо кожен епізод
// заново без ОСТАННЬОГО слайда — того, де заклик підписатися. Заклик
// лишається рівно один: в останньому епізоді останній слайд не чіпаємо.
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { downloadArchive } from './drive.js';
import { extractPhotoArchive, splitScriptLines } from './archive.js';
import { assembleVideo } from './pipeline.js';
import { remuxToReelsSpec, mixAudio } from './montage.js';
import { listVideoFiles, videoName, streamVideo } from './videos.js';
import {
  voiceClip, introKey, introLine, introTitle, factKey, factLine, factTitle, factWordForm,
  INTRO_QUESTION, INTRO_TAGLINE,
} from './voice-bank.js';
import { fileURLToPath } from 'node:url';

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
    });
  });
}

// ffmpeg пише silencedetect у stderr і завершується ненульовим кодом лише
// при справжній помилці, тож stderr забираємо окремо.
function runCaptureStderr(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stderr) reject(error); else resolve(stderr || '');
    });
  });
}

async function durationSeconds(filePath) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
  return Number(String(out).trim());
}

// Де закінчується передостанній слайд. Заклик — завжди ОСТАННЯ репліка,
// тож шукаємо останню паузу перед нею й ріжемо посередині цієї паузи.
// Хвостову тишу (яка тягнеться до кінця файлу) ігноруємо — інакше різали б
// у самому кінці й нічого не відрізали.
// Розбирає вивід silencedetect у список пауз. Чиста функція — щоб її можна
// було перевірити тестами без запуску ffmpeg.
export function parseSilenceGaps(log) {
  const gaps = [];
  let start = null;
  for (const line of String(log).split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) { start = Number(s[1]); continue; }
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && start != null) { gaps.push({ start, end: Number(e[1]) }); start = null; }
  }
  return gaps;
}

// Де закінчується передостанній слайд. Заклик — завжди ОСТАННЯ репліка, тож
// беремо останню паузу перед нею й ріжемо посередині. Хвостову тишу (яка
// тягнеться до кінця файлу) ігноруємо: інакше різали б у самому кінці й
// нічого не відрізали.
export function pickCtaCut(gaps, total, tailGuardSeconds = 1.2) {
  const inner = gaps.filter((g) => g.end < total - tailGuardSeconds);
  if (!inner.length) return { cut: null, total, gap: null };
  const last = inner[inner.length - 1];
  return {
    cut: (last.start + last.end) / 2,
    total,
    gap: Number((last.end - last.start).toFixed(2)),
  };
}

export async function ctaCutPoint(videoPath, { tailGuardSeconds = 1.2 } = {}) {
  const total = await durationSeconds(videoPath);
  const log = await runCaptureStderr('ffmpeg',
    ['-i', videoPath, '-af', 'silencedetect=noise=-30dB:d=0.35', '-f', 'null', '-']);
  return pickCtaCut(parseSilenceGaps(log), total, tailGuardSeconds);
}

export const FADE_IN = 0.25;
export const FADE_OUT = 0.4;

// Обрізає (якщо треба) і гасить краї: без затемнення епізоди злипаються в
// одну кашу й глядач не розуміє, де закінчилася історія.
async function prepare(inPath, outPath, { cut = null } = {}) {
  const dur = cut ?? await durationSeconds(inPath);
  const outAt = Math.max(0, dur - FADE_OUT).toFixed(3);
  const args = ['-y', '-i', inPath];
  if (cut != null) args.push('-t', cut.toFixed(3));
  args.push(
    '-vf', `fade=t=in:st=0:d=${FADE_IN},fade=t=out:st=${outAt}:d=${FADE_OUT}`,
    '-af', `afade=t=in:st=0:d=${FADE_IN},afade=t=out:st=${outAt}:d=${FADE_OUT}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    outPath,
  );
  await run('ffmpeg', args);
  return outPath;
}

// Роздільник між сюжетами. Три шари, зібрані самим ffmpeg — жодного
// стороннього файлу й жодної ліцензії:
//   • наростання (тон, що йде вгору) — готує вухо;
//   • удар низьким тоном — ставимо в САМИЙ КІНЕЦЬ, щоб він збігся з появою
//     наступного сюжету, а не бахнув посеред чорного кадру;
//   • повітряний хвіст із шуму — щоб удар не звучав голо.
export const SEPARATOR_SECONDS = 0.55;
const HIT_AT = 0.4; // секунда, на якій б'є удар

async function separatorArgs(outPath) {
  const d = SEPARATOR_SECONDS;
  return [
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=1080x1920:r=30:d=${d}`,
    '-f', 'lavfi', '-i', `aevalsrc=exprs=sin(2*PI*t*(250+1700*t)):d=0.45:s=48000`,
    '-f', 'lavfi', '-i', 'sine=frequency=70:duration=0.22:sample_rate=48000',
    '-f', 'lavfi', '-i', `anoisesrc=d=${d}:c=brown:a=0.6:r=48000`,
    '-filter_complex',
    '[1:a]afade=t=in:d=0.22,afade=t=out:st=0.36:d=0.09,volume=-9dB[riser];'
    + `[2:a]afade=t=out:st=0.03:d=0.19,volume=-1dB,adelay=${Math.round(HIT_AT * 1000)}|${Math.round(HIT_AT * 1000)}[hit];`
    + '[3:a]highpass=f=180,lowpass=f=5000,afade=t=in:d=0.15,afade=t=out:st=0.4:d=0.15,volume=-15dB[air];'
    + '[riser][hit][air]amix=inputs=3:duration=longest:normalize=0,'
    + 'alimiter=limit=0.95,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]',
    '-map', '0:v', '-map', '[a]', '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    outPath,
  ];
}

// Запасний варіант — той самий простий шум. Потрібен на випадок, якщо
// складений фільтр не зайде на конкретній збірці ffmpeg: краще скромний
// перехід, ніж провалена добірка.
function simpleSeparatorArgs(outPath) {
  const d = SEPARATOR_SECONDS;
  return [
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=1080x1920:r=30:d=${d}`,
    '-f', 'lavfi', '-i', `anoisesrc=d=${d}:c=brown:a=0.8`,
    '-af', `highpass=f=250,lowpass=f=3500,afade=t=in:d=0.1,afade=t=out:st=${(d - 0.25).toFixed(2)}:d=0.25`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    outPath,
  ];
}

async function makeSeparator(workDir, index, onProgress = () => {}) {
  const raw = path.join(workDir, `sep-raw-${index}.mp4`);
  try {
    await run('ffmpeg', await separatorArgs(raw));
  } catch (error) {
    onProgress(`   складений перехід не зібрався (${String(error.message).split('\n')[0]}), беру простий`);
    await run('ffmpeg', simpleSeparatorArgs(raw));
  }
  const out = path.join(workDir, `sep-${index}.mp4`);
  await remuxToReelsSpec(raw, out);
  await rm(raw, { force: true }).catch(() => {});
  return out;
}

const FONTS_DIR = fileURLToPath(new URL('../assets/fonts', import.meta.url));
export const INTRO_TAIL = 0.7; // скільки заставка висить після останнього слова
// Притемнення під написами вступу, коли під ними лежить картинка. Не одна
// плашка, а кілька смуг зі спаданням прозорості до країв: рівний прямокутник
// лишає на картинці чітку горизонтальну лінію, і вступ починає виглядати як
// знімок екрана з накладеним банером.
const INTRO_SCRIM = [
  [616, 40, 0.08], [656, 40, 0.18], [696, 40, 0.30],
  [736, 408, 0.45],
  [1144, 40, 0.30], [1184, 40, 0.18], [1224, 40, 0.08],
].map(([y, h, alpha]) => `drawbox=x=0:y=${y}:w=1080:h=${h}:color=black@${alpha}:t=fill`).join(',');

function assTime(seconds) {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
}

// Заставка малюється тими самими субтитрами, що й підписи в роликах:
// бандлений Oswald віддає кирилицю без сюрпризів, на відміну від малювання
// тексту генератором зображень.
export function introAss(big, small, seconds, top = '') {
  return [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,'
    + ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,'
    + ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Big,Oswald,150,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,2,0,1,6,0,5,80,80,0,1',
    'Style: Small,Oswald,74,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,2,0,1,4,0,5,80,80,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...(top ? [`Dialogue: 0,0:00:00.00,${assTime(seconds)},Small,,0,0,0,,{\\pos(540,780)}${top}`] : []),
    `Dialogue: 0,0:00:00.00,${assTime(seconds)},Big,,0,0,0,,{\\pos(540,900)}${big}`,
    `Dialogue: 0,0:00:00.00,${assTime(seconds)},Small,,0,0,0,,{\\pos(540,1040)}${small}`,
    '',
  ].join('\n');
}

// Вступна заставка: глядач має за перші секунди зрозуміти, що попереду
// довге відео з кількох фактів, інакше він іде, не дочекавшись другого.
// Голос беремо з банку: текст вступу залежить лише від кількості фактів, тож
// на кожну кількість він синтезується раз за все життя каналу.
async function makeIntro(workDir, { count, big, small, top, spoken, previewPath = null }, onProgress = () => {}) {
  let voicePath = null;
  let voiceSeconds = 3.2;
  try {
    voicePath = await voiceClip(introKey(count), spoken, { onProgress });
    voiceSeconds = await durationSeconds(voicePath);
  } catch (error) {
    onProgress(`   вступ без голосу: ${String(error.message).split('\n')[0]}`);
  }
  const seconds = Number((voiceSeconds + INTRO_TAIL).toFixed(2));

  const assPath = path.join(workDir, 'intro.ass');
  await writeFile(assPath, introAss(big, small, seconds, top), 'utf8');

  const silent = path.join(workDir, 'intro-silent.mp4');
  const fade = `fade=t=out:st=${(seconds - 0.4).toFixed(2)}:d=0.4`;
  if (previewPath) {
    // Картинка може прийти будь-якого розміру й співвідношення, тож спершу
    // накриваємо нею весь кадр і зрізаємо зайве по центру. Притемнена смуга
    // під написами — щоб білий текст читався й на світлому небі.
    await run('ffmpeg', ['-y', '-loop', '1', '-t', String(seconds), '-i', previewPath,
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,'
        + `${INTRO_SCRIM},subtitles=${assPath}:fontsdir=${FONTS_DIR},${fade}`,
      '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  } else {
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=black:s=1080x1920:r=30:d=${seconds}`,
      '-vf', `subtitles=${assPath}:fontsdir=${FONTS_DIR},${fade}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  }

  const withSound = path.join(workDir, 'intro-voiced.mp4');
  if (voicePath) {
    await mixAudio(silent, voicePath, withSound);
  } else {
    await run('ffmpeg', ['-y', '-i', silent, '-f', 'lavfi', '-i',
      `anullsrc=r=48000:cl=stereo:d=${seconds}`, '-shortest', '-c:v', 'copy', '-c:a', 'aac', withSound]);
  }

  const out = path.join(workDir, 'intro.mp4');
  await remuxToReelsSpec(withSound, out);
  onProgress(`вступ: ${count} фактів, ${seconds} с`);
  return out;
}

// --- Оголошення факту --------------------------------------------------------
// Перед кожним сюжетом — картка «ФАКТ 3» і голос «Факт третій». Без неї довге
// відео зливається в потік: глядач не чує, де закінчився один факт і почався
// наступний, і не має за що зачепитися, коли повертається до відео.
//
// Оголошення заміняє собою простий роздільник: у ньому вже є той самий
// перехідний звук, а два чорні кадри поспіль виглядали б як збій.
export const ANNOUNCE_LEAD = 0.45;  // скільки звучить перехід до першого слова
export const ANNOUNCE_TAIL = 0.55;  // скільки картка висить після слова

function announceFilter(assPath, seconds, delayMs) {
  return `[0:v]subtitles=${assPath}:fontsdir=${FONTS_DIR},`
    + `fade=t=out:st=${(seconds - 0.35).toFixed(2)}:d=0.35[v];`
    + `[1:a]adelay=${delayMs}|${delayMs}[voice];`
    + '[2:a]afade=t=in:d=0.22,afade=t=out:st=0.36:d=0.09,volume=-9dB[riser];'
    + `[3:a]afade=t=out:st=0.03:d=0.19,volume=-3dB,adelay=${Math.round(HIT_AT * 1000)}|${Math.round(HIT_AT * 1000)}[hit];`
    + '[4:a]highpass=f=180,lowpass=f=5000,afade=t=in:d=0.15,afade=t=out:st=0.4:d=0.15,volume=-15dB[air];'
    + '[voice][riser][hit][air]amix=inputs=4:duration=longest:normalize=0,'
    + 'alimiter=limit=0.95,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]';
}

async function makeAnnounce(workDir, { number, total }, onProgress = () => {}) {
  let voicePath = null;
  let voiceSeconds = 1.1;
  try {
    voicePath = await voiceClip(factKey(number), factLine(number), { onProgress });
    voiceSeconds = await durationSeconds(voicePath);
  } catch (error) {
    onProgress(`   оголошення ${number} без голосу: ${String(error.message).split('\n')[0]}`);
  }
  const seconds = Number((ANNOUNCE_LEAD + voiceSeconds + ANNOUNCE_TAIL).toFixed(2));

  const assPath = path.join(workDir, `announce-${number}.ass`);
  // Дрібний рядок — обов'язково зі словом: голе «З 15» під написом «ФАКТ 3»
  // читається як «3 15», бо кирилична З і трійка в цьому шрифті майже однакові.
  await writeFile(assPath, introAss(factTitle(number), `З ${total} ${factWordForm(total).toUpperCase()}`, seconds), 'utf8');

  const raw = path.join(workDir, `announce-raw-${number}.mp4`);
  // Німа картка потрібна лише запасним шляхам, тож і збирається лише там:
  // на п'ятнадцяти фактах зайве кодування 1080×1920 — це зайві хвилини.
  const card = path.join(workDir, `announce-card-${number}.mp4`);
  const buildCard = () => run('ffmpeg', ['-y',
    '-f', 'lavfi', '-i', `color=c=black:s=1080x1920:r=30:d=${seconds}`,
    '-vf', `subtitles=${assPath}:fontsdir=${FONTS_DIR},fade=t=out:st=${(seconds - 0.35).toFixed(2)}:d=0.35`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', card]);

  let built = false;
  if (voicePath) {
    try {
      await run('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', `color=c=black:s=1080x1920:r=30:d=${seconds}`,
        '-i', voicePath,
        '-f', 'lavfi', '-i', 'aevalsrc=exprs=sin(2*PI*t*(250+1700*t)):d=0.45:s=48000',
        '-f', 'lavfi', '-i', 'sine=frequency=70:duration=0.22:sample_rate=48000',
        '-f', 'lavfi', '-i', `anoisesrc=d=${seconds}:c=brown:a=0.6:r=48000`,
        '-filter_complex', announceFilter(assPath, seconds, Math.round(ANNOUNCE_LEAD * 1000)),
        '-map', '[v]', '-map', '[a]', '-t', String(seconds),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', raw,
      ]);
      built = true;
    } catch (error) {
      // Складений фільтр міг не зайти на конкретній збірці ffmpeg. Тоді
      // оголошення лишається з голосом, але без перехідного звуку — краще так,
      // ніж провалена добірка.
      onProgress(`   оголошення ${number} без переходу (${String(error.message).split('\n')[0]})`);
      await buildCard();
      await mixAudio(card, voicePath, raw);
      built = true;
    }
  }
  if (!built) {
    // Без голосу лишається сама картка з написом і тишею.
    await buildCard();
    await run('ffmpeg', ['-y', '-i', card, '-f', 'lavfi', '-i',
      `anullsrc=r=48000:cl=stereo:d=${seconds}`, '-shortest',
      '-c:v', 'copy', '-c:a', 'aac', raw]);
  }
  await rm(card, { force: true }).catch(() => {});

  const out = path.join(workDir, `announce-${String(number).padStart(2, '0')}.mp4`);
  await remuxToReelsSpec(raw, out);
  await rm(raw, { force: true }).catch(() => {});
  return out;
}

// Таймкод для опису YouTube: 0:00, 1:23, 1:02:33.
export function timecode(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// Розділи для опису: перший обов'язково з нуля, інакше YouTube їх не визнає.
// Тривалості беремо фактичні, бо епізоди різної довжини, а між ними ще й
// роздільники.
export function buildChapters(titles, durations, separatorSeconds, startAt = 0) {
  const lines = [];
  let at = startAt;
  titles.forEach((title, i) => {
    lines.push(`${timecode(at)} ${title}`);
    at += durations[i] + separatorSeconds;
  });
  return lines;
}

// Те саме, але коли перед кожним сюжетом іде оголошення «Факт N». Розділ
// починається З ОГОЛОШЕННЯ, а не з самого сюжету: глядач, що тисне таймкод,
// має почути «Факт третій», інакше він падає в середину історії.
export function buildChaptersWithLeads(titles, durations, leads, startAt = 0) {
  const lines = [];
  let at = startAt;
  titles.forEach((title, i) => {
    lines.push(`${timecode(at)} ${title}`);
    at += (leads[i] || 0) + durations[i];
  });
  return lines;
}

// Порядок епізодів у добірці — такий, як рядки лежать у таблиці: від
// найстарішого до найсвіжішого. Позначають їх у мінідодатку зверху вниз, а
// там новіші зверху — і добірка відкривалася б роликом, який глядач бачив
// позавчора. Тепер свіжий іде останнім: доки глядач до нього дійде, встигне
// подивитися все інше.
//
// Порядок беремо саме з таблиці, а не з того, як епізоди позначили: галочки
// можна ставити врозсип, і покладатися на них не варто. Дублі ID (таке в
// таблиці трапляється) беремо перші — рівно ті рядки, що й пошук за ID.
export function orderEpisodes(all, ids) {
  const wanted = new Set((ids || []).map(String));
  const firstRow = new Map();
  for (const item of all) {
    const id = String(item.id);
    if (wanted.has(id) && !firstRow.has(id)) firstRow.set(id, item);
  }
  return {
    items: all.filter((it) => firstRow.get(String(it.id)) === it),
    missing: [...wanted].filter((id) => !firstRow.has(id)),
  };
}

// Розставляє роздільники МІЖ частинами: не перед першою і не після останньої.
// Чиста функція — щоб порядок можна було перевірити тестом.
export function interleave(parts, separators) {
  const out = [];
  parts.forEach((part, i) => {
    if (i > 0) out.push(separators[i - 1]);
    out.push(part);
  });
  return out;
}

// Повторне використання: беремо ГОТОВЕ відео з Drive і ріжемо заклик по
// знайденій паузі. Озвучка не синтезується наново — нуль символів ElevenLabs.
async function reuse(item, { dropCta, workDir, index, onProgress }) {
  const files = await listVideoFiles();
  const file = files.get(videoName(item.id));
  if (!file) throw new Error(`${item.id}: готового відео немає в папці Drive.`);

  const raw = path.join(workDir, `raw-${index}.mp4`);
  const r = await streamVideo(file.id);
  await streamPipeline(r.stream, createWriteStream(raw));

  let cut = null;
  if (dropCta) {
    const found = await ctaCutPoint(raw);
    if (found.cut == null) {
      throw new Error(`${item.id}: не знайшов паузи перед закликом — цей епізод треба перезібрати.`);
    }
    cut = found.cut;
    onProgress(`   ріжу на ${cut.toFixed(1)} с із ${found.total.toFixed(1)} (пауза ${found.gap} с)`);
  }

  const faded = path.join(workDir, `faded-${index}.mp4`);
  await prepare(raw, faded, { cut });
  const source = faded;
  const normalized = path.join(workDir, `part-${String(index).padStart(2, '0')}.mp4`);
  await remuxToReelsSpec(source, normalized);
  // Проміжні файли прибираємо одразу: на п'ятнадцяти епізодах це сотні
  // мегабайтів у теці контейнера, і збірка впиралася б у диск.
  await rm(raw, { force: true }).catch(() => {});
  if (source !== raw) await rm(source, { force: true }).catch(() => {});
  return normalized;
}

// Перезбирає один епізод. dropCta — викинути останній слайд із закликом.
async function rebuild(item, { dropCta, workDir, index }) {
  const zipPath = path.join(workDir, `${index}.zip`);
  await downloadArchive(item.archive, zipPath);
  const { photoPaths, scriptText } = await extractPhotoArchive(await readFile(zipPath));

  let photos = photoPaths;
  let lines = splitScriptLines(scriptText);
  if (lines.length !== photos.length) {
    throw new Error(`${item.id}: рядків у script.txt ${lines.length}, а фото ${photos.length}.`);
  }
  if (dropCta) {
    if (photos.length <= 2) throw new Error(`${item.id}: після обрізання лишиться менше двох слайдів.`);
    photos = photos.slice(0, -1);
    lines = lines.slice(0, -1);
  }

  const { videoPath } = await assembleVideo({
    photoPaths: photos,
    theme: item.title || item.theme,
    script: lines.join('\n'),
    withVoice: true,
    // Тексти публікації для добірки не потрібні — не палимо ліміти OpenAI.
    withTexts: false,
  });

  // Однакові кодек, fps і звук у всіх частин: без цього concat дає розсинхрон.
  const faded = path.join(workDir, `faded-${index}.mp4`);
  await prepare(videoPath, faded);
  const normalized = path.join(workDir, `part-${String(index).padStart(2, '0')}.mp4`);
  await remuxToReelsSpec(faded, normalized);
  await rm(videoPath, { force: true }).catch(() => {});
  await rm(faded, { force: true }).catch(() => {});
  return normalized;
}

// 9:16 → 16:9 із розмитою підкладкою: вертикаль на комп'ютері інакше
// виглядає вузькою смужкою.
export async function toWide(inPath, outPath) {
  await run('ffmpeg', [
    '-y', '-i', inPath,
    '-filter_complex',
    '[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=40:5[bg];'
    + '[0:v]scale=-1:1080[fg];[bg][fg]overlay=(W-w)/2:0,format=yuv420p[v]',
    '-map', '[v]', '-map', '0:a',
    '-c:v', 'libx264', '-r', '30', '-c:a', 'copy',
    '-movflags', '+faststart', outPath,
  ]);
  return outPath;
}

// Головна функція. items — рядки таблиці в потрібному порядку.
// onProgress(text) — необов'язковий колбек для живого журналу.
export async function compileLong(items, { wide = false, keepCta = false, reuseVideo = true, separators = true, intro = true, announce = true, previewPath = null, onProgress = () => {} } = {}) {
  if (!Array.isArray(items) || items.length < 2) {
    throw new Error('Для добірки треба щонайменше два епізоди.');
  }
  if (!reuseVideo) {
    const missing = items.filter((it) => !it.archive);
    if (missing.length) {
      throw new Error(`Порожній архів у рядках: ${missing.map((it) => it.id).join(', ')}`);
    }
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'longcut-'));
  const parts = [];
  const durations = [];
  for (const [i, item] of items.entries()) {
    const isLast = i === items.length - 1;
    const dropCta = !keepCta && !isLast;
    onProgress(`${i + 1}/${items.length} — ${item.title || item.id}${dropCta ? '' : ' (із закликом)'}`);
    const opts = { dropCta, workDir, index: i + 1, onProgress };
    const part = reuseVideo ? await reuse(item, opts) : await rebuild(item, opts);
    parts.push(part);
    durations.push(await durationSeconds(part));
  }

  // Вступ. Без нього глядач не знає, що попереду довге відео, і йде після
  // першої ж історії, вирішивши, що це звичайний ролик.
  let introPath = null;
  let introSeconds = 0;
  if (intro) {
    onProgress('роблю вступ');
    introPath = await makeIntro(workDir, {
      count: items.length,
      top: INTRO_QUESTION,
      big: introTitle(items.length),
      small: INTRO_TAGLINE,
      spoken: introLine(items.length),
      previewPath,
    }, onProgress);
    introSeconds = await durationSeconds(introPath);
  }

  // Оголошення «Факт перший», «Факт другий»… — перед КОЖНИМ сюжетом, зокрема
  // й першим. Вони ж правлять за роздільники: перехідний звук у них уже є.
  let leads = null;
  let sequence = parts;
  if (announce) {
    onProgress('роблю оголошення фактів');
    const cards = [];
    for (let i = 0; i < parts.length; i++) {
      cards.push(await makeAnnounce(workDir, { number: i + 1, total: parts.length }, onProgress));
    }
    leads = [];
    for (const card of cards) leads.push(await durationSeconds(card));
    sequence = parts.flatMap((part, i) => [cards[i], part]);
  } else if (separators && parts.length > 1) {
    onProgress('роблю роздільники між сюжетами');
    const seps = [];
    for (let i = 0; i < parts.length - 1; i++) seps.push(await makeSeparator(workDir, i + 1, onProgress));
    sequence = interleave(parts, seps);
  }
  if (introPath) sequence = [introPath, ...sequence];

  onProgress('склеюю частини');
  const listPath = path.join(workDir, 'parts.txt');
  await writeFile(listPath, sequence.map((p) => `file '${p}'`).join('\n'), 'utf8');
  const joined = path.join(workDir, 'compilation.mp4');
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy',
    '-movflags', '+faststart', joined]);

  let final = joined;
  if (wide) {
    onProgress('перекладаю у формат шістнадцять на дев\'ять');
    final = await toWide(joined, path.join(workDir, 'compilation-16x9.mp4'));
  }
  const size = (await stat(final)).size;
  const titles = items.map((it) => it.title || it.theme || it.id);
  const episodeChapters = leads
    ? buildChaptersWithLeads(titles, durations, leads, introSeconds)
    : buildChapters(titles, durations, separators && parts.length > 1 ? SEPARATOR_SECONDS : 0, introSeconds);
  // Перший розділ мусить починатися з нуля, інакше YouTube їх не визнає.
  const chapters = introPath ? ['0:00 Вступ', ...episodeChapters] : episodeChapters;
  onProgress('готово');
  return { path: final, size, episodes: parts.length, chapters, workDir };
}
