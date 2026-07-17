// Розпакування архіву з фото від власника — ЧЕРНЕТКА (для веб-панелі).
// Власник вивантажує один .zip, де рівно 6 фото, названих 1..6. Тут архів
// розпаковується, а імена суворо звіряються — це БЕЗКОШТОВНИЙ захист від
// того, що ШІ підсунув зайве/чуже фото (voна просто не назветься 1..6).
// Змістову перевірку (безпечні зони, відповідність слайду) робить vision.js.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PHOTOS_NEEDED = 6;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Магічні байти — щоб пересвідчитись, що файл справді картинка, а не
// перейменований у .jpg сторонній файл.
async function isRealImage(filePath) {
  const buf = Buffer.from(await readFile(filePath)).subarray(0, 12);
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const webp = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return jpg || png || webp;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
    });
  });
}

// Читає перший знайдений текстовий сценарій із архіву (script.txt / text.txt),
// якщо власник поклав його поруч із фото — тоді озвучка синхронізується зі
// слайдами навіть коли в бот кинуто лише архів. Немає — повертає null.
async function readScriptText(outDir, entries) {
  const name = entries.find((n) => /^(script|text|сценарій)\.txt$/i.test(n));
  if (!name) return null;
  const text = (await readFile(path.join(outDir, name), 'utf8')).trim();
  return text || null;
}

// Розпаковує zip (base64 або Buffer). Повертає { photoPaths, scriptText }:
// рівно 6 фото в порядку 1..6 і (необов'язково) текст сценарію з архіву.
// Кидає помилку з людським описом, якщо структура не така, як домовлено.
export async function extractPhotoArchive(zipData) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'archive-'));
  const zipPath = path.join(dir, 'in.zip');
  const outDir = path.join(dir, 'out');
  const buffer = Buffer.isBuffer(zipData) ? zipData : Buffer.from(String(zipData), 'base64');
  await writeFile(zipPath, buffer);

  // -j (junk paths) сплющує будь-яку вкладеність і водночас нейтралізує
  // zip-slip (шляхи з ../). -o перезаписує, -qq тихо.
  try {
    await run('unzip', ['-j', '-o', '-qq', zipPath, '-d', outDir]);
  } catch (error) {
    throw new Error(`Не вдалося розпакувати архів: ${error.message.split('\n')[0]}`);
  }

  const entries = await readdir(outDir);
  const imageFiles = entries.filter((name) => IMAGE_EXTS.has(path.extname(name).toLowerCase()));

  // Суворо шукаємо 1..6 (будь-яке розширення). Зайві/не так названі — відсів.
  const ordered = [];
  const missing = [];
  for (let i = 1; i <= PHOTOS_NEEDED; i++) {
    const match = imageFiles.find((name) => path.parse(name).name === String(i));
    if (match) ordered.push(path.join(outDir, match)); else missing.push(i);
  }
  if (missing.length) {
    throw new Error(`В архіві бракує фото з іменами: ${missing.join(', ')} (потрібні рівно 1..6.jpg).`);
  }

  const extra = imageFiles.filter((name) => {
    const base = path.parse(name).name;
    return !/^[1-6]$/.test(base);
  });
  if (extra.length) {
    throw new Error(`В архіві зайві фото поза 1..6: ${extra.join(', ')}. Прибери їх (ШІ міг додати чуже).`);
  }

  // Перевіряємо, що всі шестеро — справжні картинки.
  for (const [index, filePath] of ordered.entries()) {
    if (!(await isRealImage(filePath))) {
      throw new Error(`Фото ${index + 1} — не дійсне зображення (можливо, перейменований сторонній файл).`);
    }
  }

  const scriptText = await readScriptText(outDir, entries);
  return { photoPaths: ordered, scriptText };
}
