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
import { remuxToReelsSpec } from './montage.js';
import { listVideoFiles, videoName, streamVideo } from './videos.js';

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
export const SEPARATOR_SECONDS = 0.6;

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

// Роздільник між сюжетами: чорний кадр із коротким «шухом». Звук робимо
// самі з брунатного шуму — ніякого стороннього файлу, ніякої ліцензії.
// Півсекунди тиші глядач читає як паузу, а зі звуком — як «почалося інше».
async function makeSeparator(workDir, index) {
  const raw = path.join(workDir, `sep-raw-${index}.mp4`);
  const d = SEPARATOR_SECONDS;
  await run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=1080x1920:r=30:d=${d}`,
    '-f', 'lavfi', '-i', `anoisesrc=d=${d}:c=brown:a=0.6`,
    '-af', `highpass=f=250,lowpass=f=3500,afade=t=in:d=0.12,afade=t=out:st=${(d - 0.28).toFixed(2)}:d=0.28,volume=-6dB`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    raw,
  ]);
  const out = path.join(workDir, `sep-${index}.mp4`);
  await remuxToReelsSpec(raw, out);
  await rm(raw, { force: true }).catch(() => {});
  return out;
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
export async function compileLong(items, { wide = false, keepCta = false, reuseVideo = true, separators = true, onProgress = () => {} } = {}) {
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
  for (const [i, item] of items.entries()) {
    const isLast = i === items.length - 1;
    const dropCta = !keepCta && !isLast;
    onProgress(`${i + 1}/${items.length} — ${item.title || item.id}${dropCta ? '' : ' (із закликом)'}`);
    const opts = { dropCta, workDir, index: i + 1, onProgress };
    parts.push(reuseVideo ? await reuse(item, opts) : await rebuild(item, opts));
  }

  let sequence = parts;
  if (separators && parts.length > 1) {
    onProgress('роблю роздільники між сюжетами');
    const seps = [];
    for (let i = 0; i < parts.length - 1; i++) seps.push(await makeSeparator(workDir, i + 1));
    sequence = interleave(parts, seps);
  }

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
  onProgress('готово');
  return { path: final, size, episodes: parts.length, workDir };
}
