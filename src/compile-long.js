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
import { downloadArchive } from './drive.js';
import { extractPhotoArchive, splitScriptLines } from './archive.js';
import { assembleVideo } from './pipeline.js';
import { remuxToReelsSpec } from './montage.js';

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
    });
  });
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
  const normalized = path.join(workDir, `part-${String(index).padStart(2, '0')}.mp4`);
  await remuxToReelsSpec(videoPath, normalized);
  await rm(videoPath, { force: true }).catch(() => {});
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
export async function compileLong(items, { wide = false, keepCta = false, onProgress = () => {} } = {}) {
  if (!Array.isArray(items) || items.length < 2) {
    throw new Error('Для добірки треба щонайменше два епізоди.');
  }
  const missing = items.filter((it) => !it.archive);
  if (missing.length) {
    throw new Error(`Порожній архів у рядках: ${missing.map((it) => it.id).join(', ')}`);
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'longcut-'));
  const parts = [];
  for (const [i, item] of items.entries()) {
    const isLast = i === items.length - 1;
    const dropCta = !keepCta && !isLast;
    onProgress(`${i + 1}/${items.length} — ${item.title || item.id}${dropCta ? '' : ' (із закликом)'}`);
    parts.push(await rebuild(item, { dropCta, workDir, index: i + 1 }));
  }

  onProgress('склеюю частини');
  const listPath = path.join(workDir, 'parts.txt');
  await writeFile(listPath, parts.map((p) => `file '${p}'`).join('\n'), 'utf8');
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
