// Веб-панель (ЧЕРНЕТКА) — майбутня заміна Telegram-боту для ПУБЛІКАЦІЇ.
// Алгоритм той самий, що в боті, але через сайт:
//   1. GET /            — сторінка зі згорнутими темами + промти + кнопка фото;
//   2. обираєш тему, копіюєш промт, генеруєш 6 фото своїм ШІ, завантажуєш;
//   3. POST /api/assemble — сайт монтує відео (спільне ядро pipeline.js) і
//      повертає прев'ю + назву/опис/хештеги;
//   4. кнопки «Опублікувати» (publish.js — поки заглушки) і «Переробити»
//      (з причиною) — перескладає відео.
//
// ВАЖЛИВО: сервер стартує ЛИШЕ коли ENABLE_WEB=1. Поки флаг не заданий —
// файл нічого не запускає, тож поточний Telegram-конвеєр не зачіпається.
// Запуск (у майбутньому, на Railway): ENABLE_WEB=1 node web/server.js
import http from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assembleVideo } from '../src/pipeline.js';
import { availablePlatforms, publishAll } from '../src/publish.js';
import { readState } from '../src/state.js';
import { FACTS_POOL, remainingFacts } from '../src/facts-pool.js';
import { extractPhotoArchive } from '../src/archive.js';
import { checkSlides } from '../src/vision.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// Готові до складання відео живуть у пам'яті процесу (чернетка; на постійному
// сервері Railway процес не вмирає, тож цього поки досить).
const assembled = new Map(); // id -> { videoPath, texts, theme }

async function buildPromptFor(theme) {
  const template = await readFile(path.join(DIR, '../prompt.template.txt'), 'utf8');
  return template.replaceAll('{{TEMA}}', theme);
}

// Список тем для панелі: пул ще не використаних фактів (кілька на вибір).
async function listThemes() {
  const state = await readState().catch(() => ({ themes: [] }));
  const used = state.themes
    .filter((t) => t.status === 'done' || t.status === 'rejected')
    .map((t) => t.title);
  const remaining = remainingFacts(used);
  const pool = remaining.length ? remaining : FACTS_POOL;
  // Кілька варіантів на вибір + скільки фото рекомендовано (наш формат — 6).
  return Promise.all(
    pool.slice(0, 8).map(async (fact) => ({
      theme: fact.text,
      category: fact.category,
      recommendedPhotos: 6,
      prompt: await buildPromptFor(fact.text),
    })),
  );
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Зберігає завантажені фото (base64 data URL або чистий base64) у тимчасові
// файли й повертає їх шляхи у порядку надходження.
async function savePhotos(photos) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'webphotos-'));
  const paths = [];
  for (const [index, raw] of photos.entries()) {
    const base64 = String(raw).includes(',') ? String(raw).split(',').pop() : String(raw);
    const filePath = path.join(dir, `photo-${index + 1}.jpg`);
    await writeFile(filePath, Buffer.from(base64, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const html = await readFile(path.join(DIR, 'public/index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, { themes: await listThemes(), platforms: availablePlatforms() });
      return;
    }

    // Складання відео з завантажених фото.
    if (req.method === 'POST' && url.pathname === '/api/assemble') {
      const { photos, theme, script } = JSON.parse(await readBody(req));
      const photoPaths = await savePhotos(photos || []);
      const { videoPath, texts } = await assembleVideo({ photoPaths, theme, script });
      const id = randomUUID();
      assembled.set(id, { videoPath, texts, theme });
      json(res, 200, { id, texts });
      return;
    }

    // Складання з АРХІВУ: власник переглядає одну зведену картинку (6 фото
    // разом) у себе, а сюди вивантажує zip, де ті самі фото окремо (1..6).
    // Агент розпаковує, звіряє імена (безкоштовний захист від чужих фото),
    // за флагом робить vision-перевірку кожного, потім монтує.
    if (req.method === 'POST' && url.pathname === '/api/assemble-zip') {
      const { zip, theme, script, slideTexts } = JSON.parse(await readBody(req));
      let photoPaths;
      try {
        photoPaths = await extractPhotoArchive(zip);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      const problems = await checkSlides(photoPaths, slideTexts || []);
      if (problems.length) {
        return json(res, 200, {
          needsFix: true,
          problems, // [{index, issue}] — які фото перезняти
        });
      }
      const { videoPath, texts } = await assembleVideo({ photoPaths, theme, script });
      const id = randomUUID();
      assembled.set(id, { videoPath, texts, theme });
      json(res, 200, { id, texts });
      return;
    }

    // Прев'ю зібраного відео.
    if (req.method === 'GET' && url.pathname.startsWith('/api/video/')) {
      const id = url.pathname.split('/').pop();
      const item = assembled.get(id);
      if (!item) return json(res, 404, { error: 'відео не знайдено' });
      res.writeHead(200, { 'content-type': 'video/mp4' });
      createReadStream(item.videoPath).pipe(res);
      return;
    }

    // Переробити (з причиною) — поки просто перескладаємо те саме відео.
    if (req.method === 'POST' && url.pathname === '/api/regenerate') {
      const { id, reason } = JSON.parse(await readBody(req));
      const item = assembled.get(id);
      if (!item) return json(res, 404, { error: 'відео не знайдено' });
      console.log(`Переробка відео ${id}. Причина: ${reason || '—'}`);
      // Чернетка: тут за причиною можна перегенерувати озвучку/тексти.
      json(res, 200, { id, texts: item.texts, note: 'переробку прийнято (чернетка)' });
      return;
    }

    // Публікація на обрані платформи (поки заглушки в publish.js).
    if (req.method === 'POST' && url.pathname === '/api/publish') {
      const { id, platforms, title, description, hashtags } = JSON.parse(await readBody(req));
      const item = assembled.get(id);
      if (!item) return json(res, 404, { error: 'відео не знайдено' });
      const results = await publishAll(platforms || [], {
        videoPath: item.videoPath,
        title,
        description,
        hashtags,
      });
      json(res, 200, { results });
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message });
  }
});

// Стартуємо ЛИШЕ за явним флагом — інакше файл безпечно бездіяльний.
if (process.env.ENABLE_WEB === '1' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => console.log(`Веб-панель на http://localhost:${PORT}`));
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Веб-панель вимкнена. Запусти з ENABLE_WEB=1, щоб увімкнути.');
}

export { server };
