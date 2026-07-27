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
import { listDoneItems, listPublishedItems, markPublished, readAllItems, readRawRows, isReady, listNewItems, updateRowPrompt, deleteQueueRow, appendRejectedTheme, listRejectedThemes } from '../src/sheets.js';
import { parseSlideLines, parseTheme, applySlideLines } from '../src/queue-prompt.js';
import { listVideos, listVideoFiles, setVideoAppProperties, streamVideo, videoName, videoFolderId, deleteVideo, remuxVideoToSpec } from '../src/videos.js';
import { startMonitor, pollOnce, forget, watchStages, watchStatus, pollStatus } from '../src/monitor.js';
import { forgetNotice } from '../src/notices.js';
import { downloadArchive } from '../src/drive.js';
import { extractPhotoArchive, splitScriptLines } from '../src/archive.js';
import { createSubmission, addPhoto, submitOwn, deleteOwnFolder } from '../src/own.js';
import { sendMessage, ownerChatId } from '../src/telegram.js';
import { startAutoPublisher, currentPublishSlot } from '../src/autopublish.js';
import { tiktokConfigured, consentUrl as tiktokConsentUrl, exchangeCode as tiktokExchangeCode, redirectUri as tiktokRedirectUri, accessToken as tiktokAccessToken, creatorInfo as tiktokCreatorInfo } from '../src/tiktok.js';
import { tokenStatus as tiktokTokenStatus } from '../src/tiktok-token.js';
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

// Одноразові state для OAuth TikTok. Живуть у пам'яті процесу: перезапуск між
// «Почати» і «Дозволити» просто вимагає повторити спробу — це дешевше, ніж
// зберігати їх десь іще.
const tiktokStates = new Map(); // state → час видачі
const TIKTOK_STATE_TTL = 15 * 60 * 1000;

function issueTiktokState() {
  const now = Date.now();
  for (const [key, at] of tiktokStates) if (now - at > TIKTOK_STATE_TTL) tiktokStates.delete(key);
  // Префікс дозволяє стороннім обробникам (напр. переадресації на чужому
  // домені) відрізнити НАШУ авторизацію від власної й не ламати її.
  const state = `cvz-${crypto.randomBytes(16).toString('hex')}`;
  tiktokStates.set(state, now);
  return state;
}

function consumeTiktokState(state) {
  if (!state || !tiktokStates.has(state)) return false;
  const at = tiktokStates.get(state);
  tiktokStates.delete(state); // одноразовий
  return Date.now() - at <= TIKTOK_STATE_TTL;
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
      const igUserId = process.env.META_IG_USER_ID;
      // Поля accounts/permissions живуть на вузлі КОРИСТУВАЧА. Для токена
      // Сторінки вони не існують, і Graph повертає «nonexisting field» —
      // це не поломка, тому й не питаємо їх у цьому випадку.
      const me = await get('me?fields=id,name,category');
      const isPageToken = Boolean(me.category);
      const [accounts, perms, ig] = await Promise.all([
        isPageToken ? Promise.resolve(null) : get('me/accounts?fields=id,name'),
        isPageToken ? Promise.resolve(null) : get('me/permissions'),
        // Головна перевірка для Reels: чи бачить токен саме той IG-акаунт,
        // у який ми публікуємо. Сам факт, що вузол читається цим токеном,
        // означає, що акаунт Business/Creator і прив'язаний до Сторінки —
        // інакше Graph його просто не віддасть.
        igUserId ? get(`${encodeURIComponent(igUserId)}?fields=id,username,followers_count,media_count`) : Promise.resolve(null),
      ]);
      const granted = (perms?.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
      const pageId = process.env.META_PAGE_ID || null;
      return json(res, 200, {
        tokenType: me.error ? 'невідомо (помилка)' : (isPageToken ? 'ТОКЕН СТОРІНКИ ✅' : 'ТОКЕН КОРИСТУВАЧА ⚠️'),
        me: me.error ? me.error.message : { id: me.id, name: me.name, category: me.category },
        // Чи це саме та сторінка, у яку публікуємо.
        pageMatches: me.id && pageId ? me.id === pageId : null,
        instagram: ig
          ? (ig.error ? `❌ ${ig.error.message}` : { id: ig.id, username: ig.username, followers: ig.followers_count, media: ig.media_count })
          : 'META_IG_USER_ID не задано',
        pagesVisible: accounts?.data ? accounts.data.map((p) => ({ id: p.id, name: p.name })) : undefined,
        grantedPermissions: isPageToken ? '(не застосовується до токена Сторінки)' : (granted.length ? granted : (perms?.error?.message ?? 'немає')),
        configuredPageId: pageId,
        configuredIgUserId: igUserId || null,
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

    // Охоплення допису. Вирішальний сигнал, коли Graph показує «Публічно», а
    // сторінка не відкривається: нуль показів = Facebook не роздає допис,
    // тобто обмеження є, просто його не видно в полях приватності.
    if (req.method === 'GET' && pathname === '/api/meta/insights') {
      const storyId = url.searchParams.get('id');
      const token = process.env.META_PAGE_ACCESS_TOKEN;
      if (!storyId) return json(res, 200, { error: 'вкажи ?id=<story id, напр. 1217780308083247_1221…>' });
      if (!token) return json(res, 200, { error: 'META_PAGE_ACCESS_TOKEN не задано' });
      try {
        const base = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}`;
        // У Reels свій набір метрик і свій edge. Пробуємо обидва: спершу
        // звичайні покази допису, потім показники відео. Graph відхиляє ВЕСЬ
        // запит через одну недійсну метрику, тож змішувати їх не можна.
        const attempts = [
          { edge: 'insights', metric: 'post_impressions,post_impressions_unique' },
          { edge: 'video_insights', metric: 'total_video_impressions,total_video_views' },
        ];
        const out = { id: storyId, tried: [] };
        for (const a of attempts) {
          const r = await fetch(
            `${base}/${encodeURIComponent(storyId)}/${a.edge}?metric=${a.metric}`
            + `&access_token=${encodeURIComponent(token)}`,
          );
          const data = await r.json();
          if (data.error) { out.tried.push(`${a.edge}: ${data.error.message}`); continue; }
          for (const m of data.data || []) out[m.name] = m.values?.[0]?.value ?? m.value ?? null;
        }
        return json(res, 200, out);
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    // Дописи у СТРІЧЦІ Сторінки. Reel і запис у стрічці — різні обʼєкти:
    // ролик може існувати як Reel, але не мати story у стрічці, і тоді
    // story.php по його ID не відкривається, а охоплення йде лише через
    // вкладку Reels. Саме це відрізняє публікацію через API від ручної.
    if (req.method === 'GET' && pathname === '/api/meta/feed') {
      const token = process.env.META_PAGE_ACCESS_TOKEN;
      const pageId = process.env.META_PAGE_ID;
      if (!token || !pageId) return json(res, 200, { error: 'META_PAGE_ACCESS_TOKEN / META_PAGE_ID не задано' });
      try {
        const base = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}`;
        const r = await fetch(
          `${base}/${encodeURIComponent(pageId)}/posts`
          + `?fields=id,created_time,permalink_url,status_type,attachments{media_type,target}`
          + `&limit=10&access_token=${encodeURIComponent(token)}`,
        );
        const data = await r.json();
        if (data.error) return json(res, 200, { error: data.error.message });
        return json(res, 200, {
          posts: (data.data || []).map((p) => ({
            id: p.id,
            created: p.created_time,
            statusType: p.status_type ?? null,
            mediaType: p.attachments?.data?.[0]?.media_type ?? null,
            targetId: p.attachments?.data?.[0]?.target?.id ?? null,
            permalink: p.permalink_url ?? null,
          })),
        });
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    // Останні Reels Сторінки з їхнім станом. Відкрити facebook.com ззовні
    // не вийде — він віддає 400 будь-якому не-браузеру, — тож єдиний чесний
    // спосіб перевірити доступність допису це спитати Graph.
    if (req.method === 'GET' && pathname === '/api/meta/reels') {
      const token = process.env.META_PAGE_ACCESS_TOKEN;
      const pageId = process.env.META_PAGE_ID;
      if (!token || !pageId) return json(res, 200, { error: 'META_PAGE_ACCESS_TOKEN / META_PAGE_ID не задано' });
      try {
        const base = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}`;
        const fields = 'id,permalink_url,privacy,published,created_time,description';
        const r = await fetch(
          `${base}/${encodeURIComponent(pageId)}/video_reels?fields=${fields}&limit=10&access_token=${encodeURIComponent(token)}`,
        );
        const data = await r.json();
        if (data.error) return json(res, 200, { error: data.error.message });
        return json(res, 200, {
          reels: (data.data || []).map((v) => ({
            id: v.id,
            permalink: v.permalink_url ? `https://www.facebook.com${v.permalink_url}` : null,
            published: v.published,
            privacy: v.privacy?.value ?? null,
            created: v.created_time,
            text: String(v.description || '').replace(/\s+/g, ' ').slice(0, 70),
          })),
        });
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    // Стан конкретного допису у Facebook: чи опублікований, яка приватність,
    // яке постійне посилання. Питання «чому одне видно без логіну, а інше ні»
    // без цього доводиться вгадувати.
    if (req.method === 'GET' && pathname === '/api/meta/post') {
      const id = url.searchParams.get('id');
      const token = process.env.META_PAGE_ACCESS_TOKEN;
      if (!id) return json(res, 200, { error: 'вкажи ?id=<facebook post id>' });
      if (!token) return json(res, 200, { error: 'META_PAGE_ACCESS_TOKEN не задано' });
      try {
        const base = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}`;
        // embeddable і targeting важливі: допис може бути «Публічно», але
        // з обмеженням аудиторії або забороною вбудовування — і тоді він
        // поводиться не так, як очікуєш, без жодної помилки в API.
        // targeting на вузлі video не існує — Graph відповідає помилкою на
        // весь запит, тож не питаємо. embeddable важливий: допис може бути
        // «Публічно», але із забороною вбудовування.
        const fields = 'id,permalink_url,privacy,published,status,created_time,title,description,'
          + 'embeddable,content_category,is_crossposting_eligible,universal_video_id';
        const r = await fetch(`${base}/${encodeURIComponent(id)}?fields=${fields}&access_token=${encodeURIComponent(token)}`);
        const data = await r.json();
        if (data.error) return json(res, 200, { error: data.error.message });
        return json(res, 200, {
          id: data.id,
          permalink: data.permalink_url ? `https://www.facebook.com${data.permalink_url}` : null,
          published: data.published,
          privacy: data.privacy || null,
          status: data.status || null,
          createdTime: data.created_time || null,
          embeddable: data.embeddable ?? null,
          crosspostEligible: data.is_crossposting_eligible ?? null,
          contentCategory: data.content_category ?? null,
        });
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    // Разова перепаковка старого ролика під специфікацію Meta Reels. Потрібна
    // лише для файлів, змонтованих до виправлення параметрів звуку; нові
    // виходять правильними одразу. Ролик перезаписується тим самим fileId,
    // мітки автопублікації не чіпаються.
    if (req.method === 'GET' && pathname === '/api/remux') {
      const id = url.searchParams.get('id');
      if (!id) return json(res, 200, { error: 'вкажи ?id=AUTO-РРРРММДД-ГГХХ' });
      try {
        return json(res, 200, await remuxVideoToSpec(id));
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    // Що саме автопублікація вже відправила: мітки живуть у appProperties
    // самого MP4, і без цього подивитися на них нема як.
    if (req.method === 'GET' && pathname === '/api/autopost/status') {
      try {
        const files = await listVideoFiles();
        const rows = [...files.values()]
          .filter((f) => Object.keys(f.appProperties || {}).length)
          .map((f) => ({
            file: f.name,
            slot: f.appProperties.autoPostSlot || null,
            skipSlot: f.appProperties.autoPostSkipSlot || null,
            facebook: f.appProperties.facebookPostId || null,
            facebookAt: f.appProperties.facebookPublishedAt || null,
            instagram: f.appProperties.instagramPostId || null,
            instagramAt: f.appProperties.instagramPublishedAt || null,
          }));
        return json(res, 200, { slot: currentPublishSlot()?.label ?? 'поза вікном', rows });
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    // «Вважати неопублікованим»: знімає з відео всі мітки автопублікації, щоб
    // воно знову стало в чергу. Потрібно, коли пост у соцмережі видалили
    // руками або він вийшов помилково. Поточне вікно при цьому закриваємо —
    // інакше матеріал вилетів би повторно вже наступним тиком.
    if (req.method === 'POST' && pathname === '/api/autopost/reset') {
      const body = JSON.parse(await readBody(req));
      const check = verifyInitData(body.initData);
      if (!check.ok) return json(res, 401, { error: 'Підпис Telegram недійсний' });
      if (!isOwner(check.user)) return json(res, 403, { error: 'Може лише власник каналу' });
      try {
        const id = String(body.id || '');
        const files = await listVideoFiles();
        const file = files.get(videoName(id));
        if (!file) throw new Error(`Відео для ${id} не знайдено в Drive`);
        const slot = currentPublishSlot();
        const cleared = await setVideoAppProperties(file.id, {
          autoPostSlot: null,
          autoPostItemId: null,
          autoPostDone: null,
          autoPostNotified: null,
          autoPostLastAttemptAt: null,
          facebookPostId: null,
          facebookPublishedAt: null,
          instagramPostId: null,
          instagramPublishedAt: null,
          // Якщо зараз усередині вікна — пропускаємо саме його, вийде в наступне.
          autoPostSkipSlot: slot ? slot.key : null,
        });
        cache.at = 0;
        return json(res, 200, {
          ok: true, id,
          skippedSlot: slot ? slot.label : null,
          remaining: Object.keys(cleared),
        });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    // Відхилення теми: прибираємо її звідусіль і запам'ятовуємо, що вона не
    // сподобалась. Рядок зникає з черги, тож без окремого запису генератор
    // запропонував би те саме вже наступного разу.
    if (req.method === 'POST' && pathname === '/api/pending/reject') {
      const body = JSON.parse(await readBody(req));
      const check = verifyInitData(body.initData);
      if (!check.ok) return json(res, 401, { error: 'Підпис Telegram недійсний' });
      if (!isOwner(check.user)) return json(res, 403, { error: 'Відхиляти може лише власник каналу' });
      try {
        const id = String(body.id || '');
        const item = (await readAllItems()).find((it) => it.id === id);
        if (!item) throw new Error(`Рядок ${id} не знайдено`);

        // Спершу стоп-лист: якщо далі щось впаде, тема принаймні не повернеться.
        await appendRejectedTheme({
          theme: item.theme,
          id,
          reason: String(body.reason || 'відхилено власником у мінідодатку'),
        });
        await deleteQueueRow(id);
        // Супутнє: змонтоване відео, папка з фото власника, пам'ять сповіщень.
        const cleanup = await Promise.allSettled([
          deleteVideo(id),
          id.startsWith('OWN-') ? deleteOwnFolder(id) : Promise.resolve(0),
          forgetNotice(id),
        ]);
        forget(id);
        cache.at = 0;
        return json(res, 200, {
          ok: true,
          theme: item.theme,
          videoRemoved: cleanup[0].status === 'fulfilled' && cleanup[0].value === true,
        });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    // Скільки тем уже у стоп-листі (діагностика).
    if (req.method === 'GET' && pathname === '/api/rejected') {
      try {
        const themes = await listRejectedThemes();
        return json(res, 200, { count: themes.length, themes });
      } catch (error) {
        return json(res, 200, { error: error.message });
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

    // --- TikTok --------------------------------------------------------------
    // Крок 1: згода. Redirect URI має бути в списку застосунку; якщо він
    // замкнений на чужий домен, задай TIKTOK_REDIRECT_URI і постав там
    // переадресацію на наш /tiktok/callback.
    if (req.method === 'GET' && pathname === '/tiktok/start') {
      if (!tiktokConfigured()) {
        return json(res, 200, { error: 'Задай TIKTOK_CLIENT_KEY і TIKTOK_CLIENT_SECRET' });
      }
      res.writeHead(302, { location: tiktokConsentUrl(issueTiktokState()) });
      return res.end();
    }

    // Крок 2: TikTok повертає code — міняємо на токени й кладемо їх на Drive.
    if (req.method === 'GET' && pathname === '/tiktok/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error || !code) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<h2>TikTok не дав дозвіл</h2><p>${error || 'немає code'}</p>`);
      }
      // Без цієї перевірки будь-хто, хто знає адресу, міг би авторизуватися
      // СВОЇМ акаунтом і підмінити збережений токен — ролики пішли б на чужий
      // профіль. Приймаємо лише code, що прийшов на наш власний state.
      if (!consumeTiktokState(url.searchParams.get('state'))) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          '<h2>Невідомий state</h2>'
          + '<p>Починай авторизацію з <code>/tiktok/start</code> цього ж застосунку. '
          + 'Якщо між кроками перезапустився сервер — просто спробуй ще раз.</p>',
        );
      }
      try {
        const saved = await tiktokExchangeCode(code);
        const direct = String(saved.scope || '').includes('video.publish');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          '<h2>TikTok підключено ✅</h2>'
          + `<p>Дозволи: <code>${saved.scope || '—'}</code></p>`
          + `<p>Режим: <b>${direct ? 'пряма публікація у стрічку' : 'чернетки застосунку (скоуп video.upload)'}</b></p>`
          + '<p>Токен збережено на Drive. Це вікно можна закрити.</p>',
        );
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<h2>Не вдалося обміняти код</h2><pre>${e.message}</pre>`);
      }
    }

    // Діагностика: чи живий токен, який режим і що дозволяє акаунт.
    // Самих токенів НЕ повертає.
    if (req.method === 'GET' && pathname === '/api/tiktok/check') {
      if (!tiktokConfigured()) return json(res, 200, { error: 'TIKTOK_CLIENT_KEY / SECRET не задано' });
      const out = { redirectUri: tiktokRedirectUri(), token: await tiktokTokenStatus() };
      try {
        const tokens = await tiktokAccessToken();
        out.scope = tokens.scope || null;
        out.mode = String(tokens.scope || '').includes('video.publish')
          ? 'пряма публікація ✅' : 'чернетки (video.upload)';
        const info = await tiktokCreatorInfo(tokens.accessToken);
        out.creator = {
          nickname: info.creator_nickname ?? null,
          privacyOptions: info.privacy_level_options ?? null,
          maxDurationSec: info.max_video_post_duration_sec ?? null,
        };
      } catch (e) {
        out.error = e.message;
      }
      return json(res, 200, out);
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
