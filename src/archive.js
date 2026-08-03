// Розпакування архіву з фото від власника.
// Власник вивантажує один .zip, де фото названі підряд 1..N (N у межах
// [MIN_PHOTOS, MAX_PHOTOS] — кількість слайдів гнучка). Тут архів
// розпаковується, а імена суворо звіряються — це БЕЗКОШТОВНИЙ захист від
// того, що ШІ підсунув зайве/чуже фото (воно просто не назветься 1..N).
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Кількість слайдів тепер гнучка — GPT обирає під тему в цих межах.
export const MIN_PHOTOS = 5;
// До 10: довша історія (20–40 с) краще тримає, якщо кожен слайд справді
// рухає розповідь. Довжина відео йде за озвучкою, тож ліміт лише страхує
// від випадкового «сміття» в архіві.
export const MAX_PHOTOS = 10;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Магічні байти — щоб пересвідчитись, що файл справді картинка, а не
// перейменований у .jpg сторонній файл.
function isImageHeader(buf) {
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const webp = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return jpg || png || webp;
}

// Пояснює, ЧОМУ файл не годиться, — щоб у Telegram прилітала дія, а не здогад.
// Повертає null, якщо з файлом усе гаразд.
//
// Найчастіший випадок — порожній файл: генератор створив 7.jpg із правильним
// іменем, але не дописав у нього жодного байта. Кількість фото тоді сходиться,
// тож самоперевірка ШІ («фото = N») цього не бачить, а власник отримував
// повідомлення про «сторонній файл» і шукав не там.
export async function imageProblem(filePath) {
  const data = Buffer.from(await readFile(filePath));
  if (data.length === 0) return 'файл порожній (0 байт), зображення не намалювалося';
  if (isImageHeader(data.subarray(0, 12))) return null;
  const head = data.subarray(0, 4).toString('hex').toUpperCase();
  return `не схоже на JPG, PNG чи WEBP (${data.length} байт, починається з ${head})`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
    });
  });
}

// Розбиває script.txt на рядки «один рядок = один слайд».
//
// Домовленість — звичайний перенос рядка, але генератор архіву не завжди його
// ставить: трапляються старі CR-переноси, юнікодні U+2028/U+2029/NEL і навіть
// ДВОСИМВОЛЬНА послідовність «\n» (коли текст записали як JSON-рядок). Усе це
// однозначні роздільники, тож приводимо їх до \n і ріжемо. Змісту не чіпаємо:
// речення НЕ розбиваємо самі — це лишається роботою автора архіву.
//
// Додатково знімаємо нумерацію на початку рядка («1. », «2) »): вона в архіві
// заборонена промтом, але як помилка інколи прослизає, а диктор інакше читає
// її вголос.
export function splitScriptLines(text) {
  const normalized = String(text)
    .replace(/^﻿/, '')            // BOM
    .replace(/\\r\\n|\\n|\\r/g, '\n')  // літеральні «\n» замість переносу
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n');
  return normalized
    .split('\n')
    .map((s) => s.trim().replace(/^\d{1,2}\s*[.)]\s+/, '').trim())
    .filter(Boolean);
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

  // Перевіряємо, що всі — справжні картинки. Повідомляємо про ВСІ биті кадри
  // одразу: інакше власник перемальовує сьомий, а на наступному запуску
  // дізнається, що восьмий теж порожній.
  const broken = [];
  for (const [index, filePath] of ordered.entries()) {
    const problem = await imageProblem(filePath);
    if (problem) broken.push(`фото ${index + 1} — ${problem}`);
  }
  if (broken.length) {
    throw new Error(`В архіві биті кадри: ${broken.join('; ')}. Перемалюй саме ці кадри й перезбери архів.`);
  }

  const scriptText = await readScriptText(outDir, entries);
  return { photoPaths: ordered, scriptText };
}
