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
import { readFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listDoneItems, listPublishedItems, markPublished, readAllItems, readRawRows, isReady, listNewItems, updateRowPrompt } from '../src/sheets.js';
import { parseSlideLines, parseTheme, applySlideLines } from '../src/queue-prompt.js';
import { listVideos, streamVideo, videoName, videoFolderId, deleteVideo } from '../src/videos.js';
import { startMonitor, pollOnce, forget, watchStages, watchStatus, pollStatus } from '../src/monitor.js';
import { downloadArchive } from '../src/drive.js';
import { extractPhotoArchive, splitScriptLines } from '../src/archive.js';
import { createSubmission, addPhoto, submitOwn } from '../src/own.js';
import { sendMessage, ownerChatId } from '../src/telegram.js';
import { startAutoPublisher } from '../src/autopublish.js';
import { metaStatus } from '../src/meta.js';
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
let cache = { at: 0, done: [], published: [], videos: new Map(), pending: [] };

async function refreshCache() {
  if (Date.now() - cache.at < CACHE_MS) return cache;
  const [done, published, videos, pending] = await Promise.all([
    listDoneItems().catch(() => []),
    listPublishedItems().catch(() => []),
    listVideos().catch(() => new Map()),
    listNewItems().catch(() => []),
  ]);
  cache = { at: Date.now(), done, published, videos, pending };
  return cache;
}

// Готові до публікації: DONE-рядки, для яких у Drive вже є відео.
// Найновіші (внизу таблиці) — зверху списку.
function queueFrom(c) {
  return c.done
    .filter((it) => c.videos.has(videoName(it.id)))
    .reverse()
    .map((it) => ({
      id: it.id,
      title: it.title,
      description: it.description,
      theme: it.theme,
      videoUrl: `/api/video/${encodeURIComponent(it.id)}`,
      downloadUrl: `/api/video/${encodeURIComponent(it.id)}?download=1`,
      fileName: videoName(it.id),
    }));
}

// Telegram Mini Apps downloadFile() вимагає Content-Disposition та CORS для
// web.telegram.org. Для звичайного прев'ю ці заголовки не додаємо, щоб відео
// й далі відтворювалося вбудованим <video>.
function videoResponseHeaders(id, upstreamHeaders = {}, asAttachment = false) {
  const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
  if (upstreamHeaders['content-length']) headers['content-length'] = upstreamHeaders['content-length'];
  if (upstreamHeaders['content-range']) headers['content-range'] = upstreamHeaders['content-range'];
  if (asAttachment) {
    headers['content-disposition'] = `attachment; filename="${videoName(id)}"`;
    headers['access-control-allow-origin'] = 'https://web.telegram.org';
  }
  return headers;
}

// Стрім відео з Drive (з підтримкою Range для перемотки).
async function serveVideo(req, res, id, asAttachment = false) {
  const c = await refreshCache();
  const fileId = c.videos.get(videoName(id));
  if (!fileId) return json(res, 404, { error: 'відео не знайдено' });
  try {
    const range = req.headers.range;
    const r = await streamVideo(fileId, range);
    const headers = videoResponseHeaders(id, r.headers, asAttachment);
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
        // Теми, які ChatGPT уже написав, але ще не малював: їх можна правити.
        pending: c.pending.map((it) => ({
          id: it.id,
          theme: it.theme || parseTheme(it.extra),
          slides: parseSlideLines(it.extra),
          note: it.note,
          created: it.created,
        })),
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
      await serveVideo(req, res, id, url.searchParams.get('download') === '1');
      return;
    }

    // Діагностика Meta-токена: який це токен (сторінки чи користувача), які
    // дозволи, чи бачить він сторінки. Сам токен НЕ повертаємо.
    if (req.method === 'GET' && pathname === '/api/meta/check') {
      const token = process.env.META_PAGE_ACCESS_TOKEN;
      if (!token) return json(res, 200, { error: 'META_PAGE_ACCESS_TOKEN не задано' });
      const base = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}`;
      const get = async (p) => {
        try {
          const r = await fetch(`${base}/${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`);
          return await r.json();
        } catch (e) { return { error: { message: e.message } }; }
      };
      const [me, accounts, perms] = await Promise.all([
        get('me?fields=id,name,category'),
        get('me/accounts?fields=id,name'),
        get('me/permissions'),
      ]);
      const granted = (perms.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
      const isPageToken = Boolean(me.category); // у токена Сторінки є category
      return json(res, 200, {
        tokenType: me.error ? 'невідомо (помилка)' : (isPageToken ? 'ТОКЕН СТОРІНКИ ✅' : 'ТОКЕН КОРИСТУВАЧА ⚠️'),
        me: me.error ? me.error.message : { id: me.id, name: me.name, category: me.category },
        pagesVisible: accounts.data ? accounts.data.map((p) => ({ id: p.id, name: p.name })) : (accounts.error?.message ?? null),
        grantedPermissions: granted.length ? granted : (perms.error?.message ?? 'немає'),
        configuredPageId: process.env.META_PAGE_ID || null,
        configuredIgUserId: process.env.META_IG_USER_ID || null,
      });
    }

    // Що реально записано в колонку G цього рядка — тобто який промт ChatGPT
    // насправді отримав. Потрібно, щоб відрізняти «промт неповний» від
    // «промт правильний, але його проігнорували».
    if (req.method === 'GET' && pathname === '/api/prompt') {
      const id = url.searchParams.get('id');
      if (!id) return json(res, 200, { error: 'вкажи ?id=AUTO-…' });
      try {
        const item = (await readAllItems()).find((it) => it.id === id);
        if (!item) return json(res, 200, { error: `рядок ${id} не знайдено` });
        // Сирі комірки: показують, у якій колонці текст лежить НАСПРАВДІ,
        // якщо в очікуваній його немає.
        const raw = (await readRawRows())[item.rowNumber - 1] || [];
        const letters = 'ABCDEFGHIJKLMN'.split('');
        const columns = letters.map((letter, i) => {
          const value = String(raw[i] ?? '');
          return { column: letter, chars: value.length, head: value.slice(0, 100) };
        });
        return json(res, 200, {
          id, row: item.rowNumber, slidesColumn: item.slides,
          chars: item.extra.length, prompt: item.extra, columns,
        });
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    // Діагностика архіву: що реально лежить у ZIP цього рядка. Показує склад
    // файлів і — головне — як розібрався script.txt (скільки рядків вийшло і
    // які саме), щоб розбіжність «рядків ≠ фото» було видно без ручного
    // завантаження. Секретів немає: це вміст архіву самого власника.
    if (req.method === 'GET' && pathname === '/api/archive') {
      const id = url.searchParams.get('id');
      if (!id) return json(res, 200, { error: 'вкажи ?id=AUTO-…' });
      try {
        const item = (await readAllItems()).find((it) => it.id === id);
        if (!item) return json(res, 200, { error: `рядок ${id} не знайдено` });
        if (!item.archive) return json(res, 200, { error: `у рядку ${id} порожня колонка «Архів»` });
        const dir = await mkdtemp(path.join(os.tmpdir(), 'diag-'));
        const zipPath = path.join(dir, 'a.zip');
        await downloadArchive(item.archive, zipPath);
        const { photoPaths, scriptText } = await extractPhotoArchive(await readFile(zipPath));
        const lines = scriptText ? splitScriptLines(scriptText) : [];
        return json(res, 200, {
          id,
          photos: photoPaths.length,
          scriptFound: Boolean(scriptText),
          scriptChars: scriptText ? scriptText.length : 0,
          // Які роздільники реально є у файлі — саме тут ховається причина.
          separators: scriptText ? {
            lf: (scriptText.match(/\n/g) || []).length,
            cr: (scriptText.match(/\r/g) || []).length,
            literalBackslashN: (scriptText.match(/\\n/g) || []).length,
            unicodeLineSep: (scriptText.match(/[\u2028\u2029]/g) || []).length,
          } : null,
          linesParsed: lines.length,
          matches: lines.length === photoPaths.length,
          lines,
        });
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    // Правка теми, яку ChatGPT уже підготував, але ще не малював. Міняємо
    // лише тексти слайдів і тему; кількість рядків лишається тією самою, щоб
    // не розійтися з колонкою «Слайдів» і кількістю майбутніх фото.
    if (req.method === 'POST' && pathname === '/api/pending/save') {
      const body = JSON.parse(await readBody(req));
      const check = verifyInitData(body.initData);
      if (!check.ok) return json(res, 401, { error: 'Підпис Telegram недійсний' });
      if (!isOwner(check.user)) return json(res, 403, { error: 'Правити може лише власник каналу' });
      try {
        const item = (await readAllItems()).find((it) => it.id === body.id);
        if (!item) throw new Error(`Рядок ${body.id} не знайдено`);
        const prompt = applySlideLines(item.extra, body.slides || []);
        await updateRowPrompt(body.id, { theme: body.theme, prompt });
        cache.at = 0;
        return json(res, 200, { ok: true, slides: (body.slides || []).length });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    // --- Власний сюжет власника ---------------------------------------------
    // Три кроки, щоб фото йшли по одному й тіло запиту лишалось малим:
    //   start  → створює папку Drive під цей матеріал;
    //   photo  → вивантажує одне фото;
    //   submit → кладе рядок NEW у таблицю з промтом під цей матеріал.
    if (req.method === 'POST' && pathname.startsWith('/api/own/')) {
      const step = pathname.slice('/api/own/'.length);
      const body = JSON.parse(await readBody(req));
      const check = verifyInitData(body.initData);
      if (!check.ok) return json(res, 401, { error: 'Підпис Telegram недійсний' });
      if (!isOwner(check.user)) return json(res, 403, { error: 'Додавати сюжети може лише власник каналу' });
      try {
        if (step === 'start') return json(res, 200, await createSubmission());
        if (step === 'photo') {
          if (!body.folderId) throw new Error('Немає folderId — почни зі старту');
          return json(res, 200, await addPhoto(body.folderId, body));
        }
        if (step === 'submit') {
          if (!body.id) throw new Error('Немає id');
          const story = String(body.story || '').trim();
          const photoCount = Number(body.photoCount) || 0;
          if (!story && !photoCount) throw new Error('Порожньо: додай сюжет або хоча б одне фото');
          const out = await submitOwn({ ...body, story, photoCount });
          cache.at = 0;
          await sendMessage(
            ownerChatId(),
            `✍️ Твій сюжет прийнято: ${out.id}\n`
            + `${photoCount ? `${photoCount} фото завантажено. ` : 'Без фото. '}`
            + 'Рядок у таблиці зі статусом NEW — ChatGPT візьме його в роботу.',
          ).catch(() => {});
          return json(res, 200, out);
        }
        return json(res, 404, { error: 'невідомий крок' });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

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

    // Перегенерувати: видалити відео з Drive і зібрати наново (новим кодом).
    if (req.method === 'POST' && pathname === '/api/regenerate') {
      const { id, initData } = JSON.parse(await readBody(req));
      const check = verifyInitData(initData);
      if (!check.ok) return json(res, 401, { error: 'Підпис Telegram недійсний' });
      if (!isOwner(check.user)) return json(res, 403, { error: 'Перегенерувати може лише власник каналу' });
      try {
        await deleteVideo(id);
        forget(id);
        cache.at = 0; // прибрати з черги одразу
        // Пересобирання — у фоні (важке); користувач отримає нове відео в Telegram.
        pollOnce().catch((e) => console.error('regenerate pollOnce:', e.message));
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    // Ручний прогін черги (для перевірки без очікування таймера).
    if (req.method === 'POST' && pathname === '/api/poll') {
      const announced = await watchStages().catch(() => 0);
      const n = await pollOnce();
      cache.at = 0;
      return json(res, 200, { checked: n, announced });
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
        watch: watchStatus(),
        poll: pollStatus(),
        serviceAccount: g.email || null,
        videoFolderSet: Boolean(videoFolderId()),
        tts: {
          engine: process.env.TTS_ENGINE || '(дефолт: openai)',
          elevenVoice: process.env.TTS_ELEVEN_VOICE_ID || '(дефолт: Callum, англ.)',
          elevenKey: Boolean(process.env.ELEVENLABS_API_KEY),
          openaiKey: Boolean(process.env.OPENAI_API_KEY),
        },
        meta: {
          ...metaStatus(),
          schedule: ['10:00', '18:00'],
          timeZone: 'Europe/Kyiv',
        },
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
    startAutoPublisher();
  } else {
    console.warn('GOOGLE_SERVICE_ACCOUNT_JSON не задано — монітор черги вимкнено (немає доступу до таблиці).');
  }
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Веб-панель вимкнена. Запусти з ENABLE_WEB=1, щоб увімкнути.');
}

export { server, verifyInitData, videoResponseHeaders };
