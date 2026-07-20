// Веб-сервер мінідодатка Telegram для каналу «Чи Ви Знали?».
// Роль: показати готові (DONE) матеріали з Google Sheet, у яких уже є
// змонтоване відео в Drive-папці «video», дати переглянути й завантажити
// відео (стрім із Drive), скопіювати назву та опис точно як у таблиці, і
// кнопкою «Опубліковано» перевести рядок DONE → PUBLISHED.
//
// Теми/сценарії/фото/архіви робить ChatGPT — додаток їх лише СПОЖИВАЄ.
// Монтаж і сповіщення веде monitor.js; сервер стартує його разом із собою.
// Стану на диску немає: джерело правди — Google Sheet + Drive.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listDoneItems, listPublishedItems, markPublished } from '../src/sheets.js';
import { listVideos, streamVideo, videoName, videoFolderId } from '../src/videos.js';
import { startMonitor, pollOnce } from '../src/monitor.js';
import { googleConfigured, googleStatus, oauthConfigured, consentUrl, exchangeCode } from '../src/google-auth.js';

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
// Гарантує, що запит на публікацію справді з мінідодатка нашого бота.
// secret = HMAC(bot_token, 'WebAppData'); HMAC(secret, data_check_string)
// має збігтися з полем hash.
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
  const authDate = Number(params.get('auth_date') || 0);
  if (authDate && Date.now() / 1000 - authDate > 86400) return { ok: false, stale: true };
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { /* ignore */ }
  return { ok: true, user };
}

// Лише власник каналу може публікувати (user.id = TELEGRAM_CHAT_ID).
function isOwner(user) {
  const owner = process.env.TELEGRAM_CHAT_ID;
  if (!owner) return true; // локальна розробка
  return user && String(user.id) === String(owner);
}

// --- Дані для мінідодатка (короткий кеш, щоб не смикати Google щоразу) ------
const CACHE_MS = 20 * 1000;
let cache = { at: 0, done: [], published: [], videos: new Map() };

async function refreshCache() {
  if (Date.now() - cache.at < CACHE_MS) return cache;
  const [done, published, videos] = await Promise.all([
    listDoneItems().catch(() => []),
    listPublishedItems().catch(() => []),
    listVideos().catch(() => new Map()),
  ]);
  cache = { at: Date.now(), done, published, videos };
  return cache;
}

// Готові до публікації: DONE-рядки, для яких у Drive вже є відео.
function queueFrom(c) {
  return c.done
    .filter((it) => c.videos.has(videoName(it.id)))
    .map((it) => ({
      id: it.id,
      title: it.title,
      description: it.description,
      theme: it.theme,
      videoUrl: `/api/video/${encodeURIComponent(it.id)}`,
    }));
}

// Стрім відео з Drive (з підтримкою Range для перемотки).
async function serveVideo(req, res, id) {
  const c = await refreshCache();
  const fileId = c.videos.get(videoName(id));
  if (!fileId) return json(res, 404, { error: 'відео не знайдено' });
  try {
    const range = req.headers.range;
    const r = await streamVideo(fileId, range);
    const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
    if (r.headers['content-length']) headers['content-length'] = r.headers['content-length'];
    if (r.headers['content-range']) headers['content-range'] = r.headers['content-range'];
    res.writeHead(range && r.headers['content-range'] ? 206 : 200, headers);
    r.stream.pipe(res);
    r.stream.on('error', () => res.destroyed || res.end());
  } catch (error) {
    if (!res.headersSent) json(res, 502, { error: `Drive: ${error.message}` });
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

    if (req.method === 'GET' && (pathname === '/api/state' || pathname === '/api/queue')) {
      const c = await refreshCache();
      json(res, 200, {
        queue: queueFrom(c),
        published: c.published.map((it) => ({
          id: it.id, title: it.title || it.theme, theme: it.theme, pubDate: it.pubDate,
        })),
        googleReady: googleConfigured(),
        videoFolderSet: Boolean(videoFolderId()),
      });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/video/')) {
      const id = decodeURIComponent(pathname.slice('/api/video/'.length));
      await serveVideo(req, res, id);
      return;
    }

    // Публікація: перевіряємо підпис, ставимо PUBLISHED у таблиці.
    if (req.method === 'POST' && pathname === '/api/publish') {
      const { id, initData } = JSON.parse(await readBody(req));
      const check = verifyInitData(initData);
      if (!check.ok) return json(res, 401, { error: 'Підпис Telegram недійсний' });
      if (!isOwner(check.user)) return json(res, 403, { error: 'Публікувати може лише власник каналу' });
      try {
        const result = await markPublished(id);
        cache.at = 0; // скинути кеш, щоб рядок одразу зник із черги
        return json(res, 200, { ok: true, date: result.date || null });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    // Ручний прогін черги (для перевірки без очікування таймера).
    if (req.method === 'POST' && pathname === '/api/poll') {
      const n = await pollOnce();
      cache.at = 0;
      return json(res, 200, { checked: n });
    }

    // OAuth: крок 1 — відправляємо власника на згоду Google.
    if (req.method === 'GET' && pathname === '/oauth/start') {
      if (!oauthConfigured()) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h2>Спершу задай GOOGLE_OAUTH_CLIENT_ID і GOOGLE_OAUTH_CLIENT_SECRET у Railway.</h2>');
        return;
      }
      res.writeHead(302, { location: consentUrl() });
      res.end();
      return;
    }

    // OAuth: крок 2 — Google повертає code; міняємо на refresh_token і
    // показуємо його, щоб вставити у змінну GOOGLE_OAUTH_REFRESH_TOKEN.
    if (req.method === 'GET' && pathname === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (err || !code) { res.end(`<h2>Помилка згоди: ${err || 'немає code'}</h2>`); return; }
      try {
        const tokens = await exchangeCode(code);
        const rt = tokens.refresh_token;
        if (!rt) {
          res.end('<h2>Google не повернув refresh_token.</h2><p>Відклич доступ на myaccount.google.com/permissions і спробуй /oauth/start ще раз (потрібен prompt=consent).</p>');
          return;
        }
        res.end(
          '<div style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6">' +
          '<h2>✅ Готово!</h2>' +
          '<p>Скопіюй цей <b>refresh token</b> і встав у Railway як змінну <code>GOOGLE_OAUTH_REFRESH_TOKEN</code>, потім збережи (буде редеплой):</p>' +
          `<textarea readonly style="width:100%;height:90px;font-family:monospace;font-size:13px;padding:10px" onclick="this.select()">${rt}</textarea>` +
          '<p style="color:#888">Цю сторінку більше нікому не показуй — токен дає доступ до твого Google.</p>' +
          '</div>',
        );
      } catch (error) {
        res.end(`<h2>Не вдалося обміняти code: ${error.message}</h2>`);
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      const g = googleStatus();
      return json(res, 200, {
        ok: true,
        googleReady: googleConfigured(),
        googleMode: g.mode,
        canUpload: g.canUpload,
        googleError: g.error,
        serviceAccount: g.email || null,
        videoFolderSet: Boolean(videoFolderId()),
      });
    }

    json(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: error.message });
  }
});

// Стартуємо ЛИШЕ за явним флагом. Монітор — якщо налаштовано Google-доступ.
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
