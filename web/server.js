// Веб-сервер мінідодатка Telegram для каналу «Чи Ви Знали?».
// Роль: показати готові (DONE) матеріали з Google Sheet, дати переглянути й
// завантажити змонтоване відео, скопіювати назву та опис точно як у таблиці,
// і кнопкою «Опубліковано» перевести рядок DONE → PUBLISHED.
//
// Теми/сценарії/фото/архіви робить ChatGPT — додаток їх лише СПОЖИВАЄ.
// Монтаж і сповіщення веде monitor.js; сервер стартує його разом із собою.
//
// Старт (Railway): node web/server.js  (потрібні змінні — див. README).
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listPublishedItems, markPublished } from '../src/sheets.js';
import { readLedger, writeLedger, videoPathFor } from '../src/storage.js';
import { startMonitor, pollOnce } from '../src/monitor.js';
import { googleConfigured, serviceAccountEmail } from '../src/google-auth.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// --- Перевірка підпису Telegram Web App (initData) -------------------------
// Гарантує, що запит на публікацію справді з мінідодатка нашого бота, а не
// підроблений. Алгоритм — офіційний: secret = HMAC(bot_token, 'WebAppData'),
// далі HMAC(secret, data_check_string) має збігтися з полем hash.
function verifyInitData(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Немає TELEGRAM_BOT_TOKEN для перевірки підпису');
  const params = new URLSearchParams(initData || '');
  const hash = params.get('hash');
  if (!hash) return { ok: false };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (calc !== hash) return { ok: false };
  // Свіжість (захист від повторів): не старше доби.
  const authDate = Number(params.get('auth_date') || 0);
  if (authDate && Date.now() / 1000 - authDate > 86400) return { ok: false, stale: true };
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { /* ignore */ }
  return { ok: true, user };
}

// Лише власник каналу може публікувати (його user.id = TELEGRAM_CHAT_ID).
function isOwner(user) {
  const owner = process.env.TELEGRAM_CHAT_ID;
  if (!owner) return true; // не задано — не обмежуємо (локальна розробка)
  return user && String(user.id) === String(owner);
}

// --- Дані для мінідодатка --------------------------------------------------
// Готові до публікації матеріали (status ready у леджері) — з назвою/описом.
async function queueItems() {
  const ledger = await readLedger();
  return Object.entries(ledger)
    .filter(([, e]) => e.status === 'ready' && e.videoFile)
    .sort((a, b) => String(b[1].readyAt).localeCompare(String(a[1].readyAt)))
    .map(([id, e]) => ({
      id,
      title: e.title || '',
      description: e.description || '',
      theme: e.theme || '',
      readyAt: e.readyAt || null,
      videoUrl: `/api/video/${encodeURIComponent(id)}`,
    }));
}

// Віддає відео з тому з підтримкою Range (щоб працювала перемотка у прев'ю).
async function serveVideo(req, res, id) {
  const file = videoPathFor(id);
  if (!existsSync(file)) return json(res, 404, { error: 'відео не знайдено' });
  const { size } = await stat(file);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, {
      'content-type': 'video/mp4',
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'accept-ranges': 'bytes' });
    createReadStream(file).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = await readFile(path.join(DIR, 'public/index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      json(res, 200, {
        queue: await queueItems(),
        published: (await listPublishedItems().catch(() => [])).map((it) => ({
          id: it.id, title: it.title || it.theme, theme: it.theme,
          pubDate: it.pubDate, description: it.description,
        })),
        googleReady: googleConfigured(),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/queue') {
      json(res, 200, { queue: await queueItems() });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/video/')) {
      const id = decodeURIComponent(pathname.slice('/api/video/'.length));
      await serveVideo(req, res, id);
      return;
    }

    // Публікація: перевіряємо підпис, ставимо PUBLISHED у таблиці, оновлюємо леджер.
    if (req.method === 'POST' && pathname === '/api/publish') {
      const { id, initData } = JSON.parse(await readBody(req));
      const check = verifyInitData(initData);
      if (!check.ok) return json(res, 401, { error: 'Підпис Telegram недійсний' });
      if (!isOwner(check.user)) return json(res, 403, { error: 'Публікувати може лише власник каналу' });
      try {
        const result = await markPublished(id);
        const ledger = await readLedger();
        if (ledger[id]) { ledger[id].status = 'published'; ledger[id].publishedAt = new Date().toISOString(); await writeLedger(ledger); }
        return json(res, 200, { ok: true, date: result.date || null });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    // Ручний прогін черги (для перевірки без очікування таймера).
    if (req.method === 'POST' && pathname === '/api/poll') {
      const n = await pollOnce();
      return json(res, 200, { checked: n });
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      return json(res, 200, { ok: true, googleReady: googleConfigured(), serviceAccount: serviceAccountEmail() });
    }

    json(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message });
  }
});

// Стартуємо ЛИШЕ за явним флагом (щоб файл лишався безпечно бездіяльним при
// імпорті в тестах). Монітор черги вмикаємо, якщо налаштовано Google-доступ.
if (process.env.ENABLE_WEB === '1' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => console.log(`Мінідодаток на порті ${PORT}`));
  if (googleConfigured()) {
    startMonitor();
  } else {
    console.warn('GOOGLE_SERVICE_ACCOUNT_JSON не задано — монітор черги вимкнено (немає доступу до таблиці).');
  }
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Веб-панель вимкнена. Запусти з ENABLE_WEB=1, щоб увімкнути.');
}

export { server, verifyInitData };
