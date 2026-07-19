// Розпакування архіву з фото від власника.
// Власник вивантажує один .zip, де фото названі підряд 1..N (N у межах
// [MIN_PHOTOS, MAX_PHOTOS] — кількість слайдів гнучка). Тут архів
// розпаковується, а імена суворо звіряються — це БЕЗКОШТОВНИЙ захист від
// того, що ШІ підсунув зайве/чуже фото (воно просто не назветься 1..N).
// Змістову перевірку (безпечні зони, відповідність слайду) робить vision.js.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Кількість слайдів тепер гнучка — GPT обирає під тему в цих межах.
export const MIN_PHOTOS = 5;
export const MAX_PHOTOS = 8;
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
// фото в порядку 1..N (N у межах [MIN,MAX]) і (необов'язково) сценарій з архіву.
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

  // Фото мають бути названі підряд 1..N (будь-яке розширення), N у межах
  // [MIN_PHOTOS, MAX_PHOTOS]. Не-числові імена — відсів (захист від чужих фото).
  const numbered = imageFiles.filter((name) => /^\d+$/.test(path.parse(name).name));
  const others = imageFiles.filter((name) => !/^\d+$/.test(path.parse(name).name));
  if (others.length) {
    throw new Error(`В архіві зайві фото поза нумерацією: ${others.join(', ')}. Прибери їх (ШІ міг додати чуже).`);
  }
  if (numbered.length === 0) {
    throw new Error(`В архіві немає фото, названих числами 1..N (потрібно ${MIN_PHOTOS}–${MAX_PHOTOS}).`);
  }

  const nums = numbered.map((name) => Number(path.parse(name).name));
  const maxN = Math.max(...nums);
  if (maxN < MIN_PHOTOS || maxN > MAX_PHOTOS) {
    throw new Error(`Потрібно ${MIN_PHOTOS}–${MAX_PHOTOS} фото, названих підряд 1..N; найбільший номер в архіві — ${maxN}.`);
  }

  const ordered = [];
  const missing = [];
  for (let i = 1; i <= maxN; i++) {
    const matches = numbered.filter((name) => Number(path.parse(name).name) === i);
    if (matches.length === 0) missing.push(i);
    else ordered.push(path.join(outDir, matches[0]));
  }
  if (missing.length) {
    throw new Error(`В архіві бракує фото: ${missing.join(', ')} (потрібні підряд 1..${maxN}).`);
  }
  if (numbered.length !== maxN) {
    throw new Error('В архіві дублікати номерів фото — має бути рівно по одному 1..N.');
  }

  // Перевіряємо, що всі — справжні картинки.
  for (const [index, filePath] of ordered.entries()) {
    if (!(await isRealImage(filePath))) {
      throw new Error(`Фото ${index + 1} — не дійсне зображення (можливо, перейменований сторонній файл).`);
    }
  }

  const scriptText = await readScriptText(outDir, entries);
  return { photoPaths: ordered, scriptText };
}
