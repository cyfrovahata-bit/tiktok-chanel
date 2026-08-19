// Складання довгої добірки з уже готових епізодів («чистий шлях»).
//
// Ідея: НЕ різати готові MP4 наосліп, а перезібрати кожен епізод з його
// архіву заново, викинувши ОСТАННІЙ слайд — той, де заклик підписатися.
// Двадцять закликів поспіль убивають добірку, тож заклик лишається рівно
// один: в останньому епізоді останній слайд не чіпаємо.
//
// Запуск:
//   node scripts/compile-long.js --limit 3
//   node scripts/compile-long.js --ids AUTO-20260816-1203,AUTO-20260817-0910
//   node scripts/compile-long.js --limit 10 --wide      (16:9 для YouTube)
//   node scripts/compile-long.js --limit 3 --keep-cta   (не різати хвости)
//
// Результат — локальний mp4, шлях друкується в кінці. На Drive нічого не
// заливається: це навмисно, щоб пробну збірку можна було спершу подивитись.
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { readAllItems } from '../src/sheets.js';
import { downloadArchive } from '../src/drive.js';
import { extractPhotoArchive, splitScriptLines } from '../src/archive.js';
import { assembleVideo } from '../src/pipeline.js';
import { remuxToReelsSpec } from '../src/montage.js';

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
    });
  });
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

// Які епізоди беремо: явний список ID або N найсвіжіших опублікованих.
async function pickItems() {
  const items = await readAllItems();
  const usable = items.filter((it) => it.archive && it.title);
  const ids = arg('ids');
  if (ids) {
    const wanted = ids.split(',').map((s) => s.trim()).filter(Boolean);
    const found = wanted.map((id) => {
      const item = usable.find((it) => it.id === id);
      if (!item) throw new Error(`Рядка ${id} немає або в ньому порожній архів чи назва.`);
      return item;
    });
    return found;
  }
  const limit = Number(arg('limit', '3'));
  // Найсвіжіші зверху: у таблиці рядки йдуть за часом додавання.
  const published = usable.filter((it) => it.status === 'PUBLISHED');
  const pool = published.length >= limit ? published : usable;
  return pool.slice(-limit);
}

// Перезбирає один епізод без останнього слайда. Повертає шлях до mp4.
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
    withTexts: false, // тексти публікації для добірки не потрібні — не палимо ліміти OpenAI
  });

  // Однакові кодек, fps і звук у всіх частин — без цього concat дає розсинхрон.
  const normalized = path.join(workDir, `part-${String(index).padStart(2, '0')}.mp4`);
  await remuxToReelsSpec(videoPath, normalized);
  await rm(videoPath, { force: true }).catch(() => {});
  return normalized;
}

// 9:16 → 16:9 із розмитою підкладкою: вертикаль на комп'ютері інакше
// виглядає вузькою смужкою.
async function toWide(inPath, outPath) {
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

async function main() {
  const dropCtaEverywhere = !flag('keep-cta');
  const items = await pickItems();
  if (!items.length) throw new Error('Не знайшов жодного придатного епізоду.');

  console.log(`Беру ${items.length} епізод(и):`);
  items.forEach((it, i) => console.log(`  ${i + 1}. ${it.id} — ${it.title}`));

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'longcut-'));
  const parts = [];
  for (const [i, item] of items.entries()) {
    const isLast = i === items.length - 1;
    // Заклик лишаємо тільки в останньому епізоді — один на всю добірку.
    const dropCta = dropCtaEverywhere && !isLast;
    process.stdout.write(`  збираю ${item.id}${dropCta ? ' (без заклику)' : ' (із закликом)'}… `);
    parts.push(await rebuild(item, { dropCta, workDir, index: i + 1 }));
    console.log('готово');
  }

  const listPath = path.join(workDir, 'parts.txt');
  await writeFile(listPath, parts.map((p) => `file '${p}'`).join('\n'), 'utf8');
  const joined = path.join(workDir, 'compilation.mp4');
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy',
    '-movflags', '+faststart', joined]);

  const final = flag('wide') ? await toWide(joined, path.join(workDir, 'compilation-16x9.mp4')) : joined;
  const size = (await stat(final)).size;
  console.log(`\nГотово: ${final}`);
  console.log(`Розмір: ${(size / 1024 / 1024).toFixed(1)} МБ, епізодів: ${parts.length}`);
}

main().catch((error) => {
  console.error(`\nПомилка: ${error.message}`);
  process.exit(1);
});
