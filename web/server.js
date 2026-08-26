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
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listDoneItems, listPublishedItems, markPublished, readAllItems, readRawRows, isReady, listNewItems, listErrorItems, updateRowPrompt, deleteQueueRow, appendRejectedTheme, listRejectedThemes } from '../src/sheets.js';
import { parseSlideLines, parseTheme, applySlideLines } from '../src/queue-prompt.js';
import { listVideos, listVideoFiles, setVideoAppProperties, streamVideo, videoName, videoProps, videoFolderId, deleteVideo, remuxVideoToSpec, uploadVideo } from '../src/videos.js';
import { startMonitor, pollOnce, forget, watchStages, watchStatus, pollStatus } from '../src/monitor.js';
import { forgetNotice } from '../src/notices.js';
import { nextDailyTimes, kyivToday, kyivMinutes } from '../src/kyiv.js';
import { photoSchedule } from '../src/photo-plan.js';
import { downloadArchive } from '../src/drive.js';
import { extractPhotoArchive, splitScriptLines } from '../src/archive.js';
import { compileLong, orderEpisodes } from '../src/compile-long.js';
import { savePreview, previewInfo, removePreview, fetchPreview } from '../src/preview.js';
import { createSubmission, addPhoto, submitOwn, submitSurname, deleteOwnFolder, extractOwnStory } from '../src/own.js';
import { sendMessage, ownerChatId } from '../src/telegram.js';
import { startAutoPublisher, currentPublishSlot, publishHours, platformHours, claimProperty } from '../src/autopublish.js';
import { availablePlatforms } from '../src/publish.js';
import { tiktokConfigured, consentUrl as tiktokConsentUrl, exchangeCode as tiktokExchangeCode, redirectUri as tiktokRedirectUri, accessToken as tiktokAccessToken, creatorInfo as tiktokCreatorInfo } from '../src/tiktok.js';
import { tokenStatus as tiktokTokenStatus } from '../src/tiktok-token.js';
import { metaStatus } from '../src/meta.js';
import { googleConfigured, googleStatus, oauthConfigured, consentUrl, youtubeConsentUrl, exchangeCode, tokenScopes, youtubeTokenScopes, youtubeTokenSource } from '../src/google-auth.js';
import { channelInfo, channelVideoStats } from '../src/youtube.js';
import { registerPlatform, startCommentWatcher, checkAll, pendingSummary, cleanupStale, rethinkSkipped } from '../src/comment-flow.js';
import { youtubeAdapter } from '../src/yt-comments.js';
import { facebookAdapter, instagramAdapter } from '../src/meta-comments.js';
import { startTelegramLoop } from '../src/telegram-loop.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// Довга добірка з готових епізодів. Тримаємо РІВНО ОДНЕ завдання за раз:
// збірка перекодовує відео й синтезує озвучку наново, тож два паралельні
// запуски просто з'їдять контейнер. Стан живе в пам'яті — після перезапуску
// сервісу готовий файл зникає разом із тимчасовою текою, і це нормально:
// добірку качають одразу, а не через тиждень.
let compileJob = null;

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
let cache = { at: 0, done: [], published: [], videos: new Map(), pending: [], problems: [] };

async function refreshCache() {
  if (Date.now() - cache.at < CACHE_MS) return cache;
  // Беремо файли разом з appProperties: без них не порахувати, кому який слот
  // публікації дістанеться — мітки автопублікації живуть саме там.
  const [done, published, files, pending, problems] = await Promise.all([
    listDoneItems().catch(() => []),
    listPublishedItems().catch(() => []),
    listVideoFiles().catch(() => new Map()),
    listNewItems().catch(() => []),
    listErrorItems().catch(() => []),
  ]);
  const videos = new Map([...files].map(([name, file]) => [name, file.id]));
  cache = { at: Date.now(), done, published, files, videos, pending, problems };
  return cache;
}

// Години, коли ChatGPT за відкладеним завданням малює фото. Наш код їх не
// запускає — це зовнішній розклад, — але знати його треба, щоб показати,
// скільки лишилось чекати на відео.
function photoHours() {
  return String(process.env.AUTO_PHOTO_HOURS || '7,12,16')
    .split(',')
    .map((h) => Number(String(h).trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
}

// Коли ролик почне виходити. Раніше тут була проста арифметика «скільки в
// черзі — стільки й наступних вікон підряд», і з роздільним розкладом вона
// брехала: новому ролику показувалося найближче вікно будь-якої платформи,
// хоча насправді перед ним стоять ті, кому ще бракує своїх платформ.
//
// Тому програємо чергу так само, як це робить autopublish: черга спільна,
// кожне вікно належить конкретній платформі, і поки головний ролик не
// отримали ВСІ, наступний не рушає.
function publishSchedule(c, now = new Date()) {
  const wanted = PLATFORM_KEYS.filter(platformEnabled);
  if (!wanted.length) return new Map();

  // Порядок як у таблиці: найстаріші рядки згори — саме так їх бере черга.
  const pending = c.done
    .filter((it) => c.videos.has(videoName(it.id)))
    .map((it) => {
      const props = videoProps(c.files, it.id);
      return { id: it.id, need: new Set(wanted.filter((p) => !props[`${p}PostId`])) };
    })
    .filter((row) => row.need.size);
  if (!pending.length) return new Map();

  // Майбутні вікна, згруповані за часом: платформи з однаковою годиною
  // обробляються разом і беруть ОДИН ролик на всіх — так само, як у runGroup.
  const windows = new Map();
  for (const platform of wanted) {
    for (const at of nextDailyTimes(platformHours(platform), 12, now)) {
      const key = at.getTime();
      if (!windows.has(key)) windows.set(key, []);
      windows.get(key).push(platform);
    }
  }

  const at = new Map();
  let head = 0;
  for (const key of [...windows.keys()].sort((a, b) => a - b)) {
    if (head >= pending.length) break;
    const row = pending[head];
    // Група вже має цей ролик — вікно проходить вхолосту (in-step), і на
    // наступний ролик вона в цьому ж вікні НЕ переходить.
    const acting = windows.get(key).filter((platform) => row.need.has(platform));
    if (!acting.length) continue;
    if (!at.has(row.id)) at.set(row.id, new Date(key).toISOString());
    for (const platform of acting) row.need.delete(platform);
    if (!row.need.size) head += 1;
  }
  return at;
}

// Готові до публікації: DONE-рядки, для яких у Drive вже є відео.
// Найновіші (внизу таблиці) — зверху списку.
const POST_ID_KEYS = ['facebookPostId', 'instagramPostId', 'tiktokPostId', 'youtubePostId'];
const PLATFORM_KEYS = ['youtube', 'tiktok', 'instagram', 'facebook'];

// Чи публікує цю платформу автопублікація. Facebook вимкнено в коді
// (див. autopublish.js), тож він завжди «вручну» — і ніколи не тримає
// картку в очікуванні.
function platformEnabled(platform) {
  if (platform === 'facebook') return false;
  return process.env[`ENABLE_${platform === 'instagram' ? 'IG' : platform.toUpperCase()}`] === '1';
}

function queueFrom(c, now = new Date()) {
  const schedule = publishSchedule(c, now);
  return c.done
    .filter((it) => c.videos.has(videoName(it.id)))
    .reverse()
    .map((it) => {
      const props = videoProps(c.files, it.id);
      const autoPosted = POST_ID_KEYS.some((key) => props[key]);
      // Стан кожної платформи окремо. Без цього картка показувала єдиний
      // прапорець «опубліковано», який вмикався від першої ж платформи — і
      // не було видно, що решта ще чекає свого вікна. Через це «Опубліковано»
      // тиснули зарано, а рядок у статусі PUBLISHED автопублікація вже не
      // бере, тож ті платформи лишалися без ролика назавжди.
      const platforms = PLATFORM_KEYS.map((platform) => ({
        platform,
        enabled: platformEnabled(platform),
        done: Boolean(props[`${platform}PostId`]),
        at: props[`${platform}PublishedAt`] || null,
      }));
      return {
        id: it.id,
        title: it.title,
        description: it.description,
        theme: it.theme,
        videoUrl: `/api/video/${encodeURIComponent(it.id)}`,
        downloadUrl: `/api/video/${encodeURIComponent(it.id)}?download=1`,
        fileName: videoName(it.id),
        publishAt: schedule.get(it.id) || null,
        autoPosted,
        platforms,
        // Чекають ще платформи, у яких увімкнена автопублікація — тиснути
        // «Опубліковано» рано.
        awaiting: platforms.filter((p) => p.enabled && !p.done).map((p) => p.platform),
        // Заявка є, а публікації немає: ролик випав із черги й повернути його
        // може лише кнопка ↩️.
        stalled: Boolean(props.autoPostSlot) && !autoPosted,
      };
    });
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
    // Обрив на середині — це НЕ нормальне завершення. Раніше тут стояв
    // res.end(), і клієнт отримував менше байтів, ніж обіцяв content-length,
    // вважаючи файл цілим. Тепер рвемо з'єднання: так завантажувач бачить
    // збій і може повторити. Помилку пишемо в лог — без цього обриви з боку
    // Drive були невидимі й доводилося гадати.
    r.stream.on('error', (error) => {
      console.error(`Відео ${id}: стрім Drive обірвався — ${error.message}`);
      if (!res.destroyed) res.destroy();
    });
  } catch (error) {
    console.error(`Відео ${id}: Drive не віддав файл — ${error.message}`);
    if (!res.headersSent) json(res, 502, { error: `Drive: ${error.message}` });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    // Публічні сторінки для аудиту YouTube API: рецензент має побачити, що це
    // за клієнт і як він поводиться з даними. Кореневий шлях для цього не
    // годиться — там мінідодаток, який поза Telegram виглядає порожнім.
    if (req.method === 'GET' && (pathname === '/about' || pathname === '/privacy' || pathname === '/terms')) {
      const html = await readFile(path.join(DIR, `public${pathname}.html`), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = await readFile(path.join(DIR, 'public/index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && (pathname === '/api/state' || pathname === '/api/queue')) {
      const c = await refreshCache();
      const now = new Date();
      // Кожному рядку — своя година: ChatGPT малює по одному рядку за запуск.
      const photoAt = photoSchedule(c.pending, photoHours(), now);
      json(res, 200, {
        // Теми, які ChatGPT уже написав, але ще не малював: їх можна правити.
        // Порядок карток = порядок черги на малювання, а не порядок рядків у
        // таблиці. Інакше рядок, який щойно посунули вперед, лишається
        // візуально третім, і власник вважає, що зміна не спрацювала.
        pending: c.pending
          .map((it) => ({
            id: it.id,
            theme: it.theme || parseTheme(it.extra),
            slides: parseSlideLines(it.extra),
            note: it.note,
            created: it.created,
            photoAt: photoAt.get(it.id) || null,
          }))
          .sort((a, b) => {
            if (a.photoAt && b.photoAt) return a.photoAt.localeCompare(b.photoAt);
            if (!a.photoAt && b.photoAt) return 1;   // без часу — у кінець
            if (a.photoAt && !b.photoAt) return -1;
            return 0;
          }),
        queue: queueFrom(c, now),
        // Рядки, які ChatGPT зупинив на перевірці фактів. Без них сюжет
        // зникав із застосунку мовчки — статус ERROR не показувався ніде.
        // Віддаємо ще й вихідний текст, щоб надіслати сюжет заново можна було
        // без пошуків у таблиці.
        problems: c.problems.map((it) => {
          const slides = parseSlideLines(it.extra);
          return {
            id: it.id,
            theme: it.theme || parseTheme(it.extra),
            note: it.note,
            created: it.created,
            story: extractOwnStory(it.extra) || slides.join('\n'),
          };
        }),
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

    // --- Довга добірка ------------------------------------------------
    // Збирає кілька готових епізодів в один довгий ролик: кожен
    // перезбирається з архіву БЕЗ останнього слайда (заклик підписатися),
    // і лише в останньому епізоді заклик лишається. Робота довга, тому
    // запуск і опитування стану рознесені: старт віддає відповідь одразу.
    // Прев'ю добірки: картинка, яку власник намалював у ChatGPT. Лягає на Drive
    // під сталим іменем, тож переживає передеплой і використовується щотижня,
    // доки її не замінять. Тіло приймаємо як base64 у JSON — тим самим шляхом,
    // що й фото власних сюжетів.
    if (pathname === '/api/compile/preview') {
      if (req.method === 'GET') {
        try { return json(res, 200, await previewInfo()); }
        catch (error) { return json(res, 200, { exists: false, error: error.message }); }
      }
      if (req.method === 'POST') {
        // Довжину перевіряємо ДО читання тіла: інакше будь-хто, хто знає
        // адресу, залив би в пам'ять процесу скільки завгодно ще до перевірки
        // підпису.
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > 20 * 1e6) return json(res, 413, { error: 'Завелике тіло запиту' });
        const body = JSON.parse(await readBody(req));
        const check = verifyInitData(body.initData);
        if (!check.ok) return json(res, 401, { error: 'Підпис Telegram недійсний' });
        if (!isOwner(check.user)) return json(res, 403, { error: 'Міняти прев\'ю може лише власник каналу' });
        try {
          if (body.remove) return json(res, 200, { removed: await removePreview(), exists: false });
          const saved = await savePreview(body);
          return json(res, 200, { ok: true, exists: true, ...saved });
        } catch (error) {
          return json(res, 400, { error: error.message });
        }
      }
    }

    if (req.method === 'POST' && pathname === '/api/compile/start') {
      const body = JSON.parse(await readBody(req));
      const check = verifyInitData(body.initData);
      if (!check.ok) return json(res, 401, { error: 'Підпис Telegram недійсний' });
      if (!isOwner(check.user)) return json(res, 403, { error: 'Збирати добірку може лише власник каналу' });
      if (compileJob?.state === 'running') return json(res, 409, { error: 'Збірка вже триває' });

      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (ids.length < 2) return json(res, 400, { error: 'Познач щонайменше два епізоди' });
      // Порядок — за таблицею (найстаріший перший), а не за тим, у якому
      // порядку епізоди позначили: свіжий ролик має йти останнім.
      const all = await readAllItems();
      const { items, missing } = orderEpisodes(all, ids);
      if (missing.length) return json(res, 400, { error: `Рядок ${missing[0]} не знайдено` });
      const empty = items.find((it) => !it.archive);
      if (empty) return json(res, 400, { error: `У рядку ${empty.id} порожня колонка «Архів»` });

      const startedAt = Date.now();
      // Ідентифікатор збірки їде і в URL, і в ім'я файлу: інакше завантажувач
      // бачить ту саму адресу «/api/compile/file» і віддає з кешу ПЕРШУ
      // добірку, скільки б нових ти не зібрав.
      const jobId = String(startedAt);
      const job = { id: jobId, state: 'running', log: [], startedAt, path: null, size: 0, episodes: 0, error: null, wide: !!body.wide };
      compileJob = job;
      // Навмисно НЕ чекаємо: збірка триває хвилини, а HTTP-запит стільки не живе.
      // За замовчуванням беремо ГОТОВІ відео з Drive і ріжемо заклик по паузі:
      // так добірка не коштує жодного символу ElevenLabs. rebuild=true вмикає
      // повну перезбірку з архівів (потрібна, якщо пауза не знаходиться).
      // announce вмикає вступ «У цьому відео 15 фактів про Україну» і картки
      // «Факт перший» перед кожним сюжетом. Голос для них береться з
      // голосового банку (assets/voice), тож він теж нічого не коштує.
      // Прев'ю тягнемо з Drive заздалегідь: воно потрібне вже на першому кроці
      // (вступ), а лізти в мережу з надр збірки — зайва точка відмови.
      const previewPath = body.preview === false ? null : await fetchPreview(
        path.join(os.tmpdir(), `compilation-preview-${jobId}.jpg`),
      ).catch((error) => { job.log.push(`прев'ю не завантажилось: ${error.message}`); return null; });
      if (previewPath) job.log.push('прев\'ю на місці — вступ буде на ньому');

      compileLong(items, {
        wide: !!body.wide,
        reuseVideo: !body.rebuild,
        announce: body.announce !== false,
        previewPath,
        onProgress: (text) => job.log.push(text),
      })
        .then(async (r) => {
          Object.assign(job, { path: r.path, size: r.size, episodes: r.episodes, chapters: r.chapters });
          // Кладемо готову добірку на Drive ОДРАЗУ. Тимчасова тека й пам'ять
          // процесу не переживають передеплою, і власник лишався з мовчазною
          // кнопкою. Автопублікація такий файл не візьме: вона шукає рівно
          // videoName(id) рядків таблиці, а тут ім'я compilation-…
          try {
            job.log.push('кладу на Drive');
            const name = `compilation-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
            const fileId = await uploadVideo(name, r.path);
            Object.assign(job, { driveId: fileId, driveUrl: `https://drive.google.com/file/d/${fileId}/view` });
          } catch (error) {
            job.log.push(`на Drive не поклав: ${error.message}`);
          }
          job.state = 'done';
        })
        .catch((error) => Object.assign(job, { state: 'failed', error: error.message }));
      return json(res, 200, { ok: true, episodes: items.length });
    }

    if (req.method === 'GET' && pathname === '/api/compile/status') {
      if (!compileJob) return json(res, 200, { state: 'idle' });
      const { id, state, log, error, size, episodes, wide, startedAt, driveUrl, chapters } = compileJob;
      return json(res, 200, {
        state, log, error, size, episodes, wide, driveUrl, chapters,
        fileUrl: `/api/compile/file/${id}.mp4`,
        fileName: `compilation-${id}.mp4`,
        seconds: Math.round((Date.now() - startedAt) / 1000),
      });
    }

    if (req.method === 'GET' && pathname.startsWith('/api/compile/file')) {
      if (compileJob?.state !== 'done') return json(res, 404, { error: 'готового файлу немає' });
      // У шляху стоїть ідентифікатор збірки. Якщо просять стару — кажемо про це
      // прямо, а не підсовуємо мовчки іншу.
      const asked = pathname.slice('/api/compile/file'.length).replace(/^\//, '').replace(/\.mp4$/, '');
      if (asked && asked !== compileJob.id) {
        return json(res, 404, { error: 'ця збірка вже застаріла — онови сторінку' });
      }
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(compileJob.size),
        'content-disposition': `attachment; filename="compilation-${compileJob.id}.mp4"`,
        'cache-control': 'no-store, must-revalidate',
      });
      const stream = createReadStream(compileJob.path);
      stream.pipe(res);
      stream.on('error', (error) => {
        console.error(`Добірка: не вдалося віддати файл — ${error.message}`);
        if (!res.destroyed) res.destroy();
      });
      return;
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

    // Метрики ВСІХ Reels Сторінки однією таблицею: перегляди, лайки,
    // коментарі, поширення, середній час перегляду й перший рядок допису.
    //
    // Навіщо окремо від /api/meta/insights: той віддає один допис за запитом,
    // а питання «які сюжети заходять» на одному дописі не вирішується. Тут
    // видно всі ролики поруч, і перший рядок допису — це слайд 1 сценарію,
    // тобто саме те, що вирішує долю ролика в стрічці.
    //
    // Graph відхиляє ВЕСЬ запит через одну недійсну метрику, тому набори
    // метрик пробуються по черзі, а не змішуються.
    if (req.method === 'GET' && pathname === '/api/meta/stats') {
      const token = process.env.META_PAGE_ACCESS_TOKEN;
      const pageId = process.env.META_PAGE_ID;
      if (!token || !pageId) return json(res, 200, { error: 'META_PAGE_ACCESS_TOKEN / META_PAGE_ID не задано' });
      const base = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}`;
      const auth = `access_token=${encodeURIComponent(token)}`;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 400);

      const METRIC_SETS = [
        'blue_reels_play_count,post_video_avg_time_watched,post_video_view_time',
        'total_video_views,total_video_impressions,total_video_view_total_time',
        'total_video_views',
      ];

      // ?probe=<video id> — режим розвідки. Метрики Reels у Graph називаються
      // не так, як у звичайних відео, а документація відстає від API. Тут
      // кожен кандидат питається ОКРЕМИМ запитом, тож видно поіменно, який
      // працює, а який ні — інакше одна погана назва валить увесь запит і
      // причина лишається невидимою.
      const probeId = url.searchParams.get('probe');
      if (probeId) {
        const candidates = [
          'blue_reels_play_count', 'post_video_avg_time_watched', 'post_video_view_time',
          'total_video_views', 'total_video_impressions', 'total_video_views_unique',
          'total_video_view_total_time', 'total_video_10s_views', 'total_video_complete_views',
          'total_video_reactions_by_type_total', 'blue_reels_total_plays',
          'post_impressions', 'post_impressions_unique', 'post_video_views',
        ];
        const out = {};
        for (const metric of candidates) {
          for (const edge of ['video_insights', 'insights']) {
            const data = await (await fetch(`${base}/${encodeURIComponent(probeId)}/${edge}?metric=${metric}&${auth}`)).json();
            if (data.error) { out[`${edge}:${metric}`] = `ERR ${data.error.message}`; continue; }
            const v = (data.data || []).map((m) => `${m.name}=${JSON.stringify(m.values?.[0]?.value ?? m.value ?? null)}`);
            out[`${edge}:${metric}`] = v.length ? v.join(', ') : 'порожньо';
          }
        }
        return json(res, 200, { probe: probeId, results: out });
      }

      try {
        // 1) Перелік роликів із лічильниками реакцій.
        // shares на вузлі video_reels не існує — Graph відповідає помилкою на
        // ВЕСЬ запит, і список приходить порожній. Поширення беремо з метрик.
        //
        // reactions, а не likes: likes.summary рахує ЛИШЕ «подобається», тоді
        // як під дописом стоять ще «супер», «ого», «сумно» тощо. Через це
        // перший розбір занизив усі числа в кілька разів.
        // filter(stream) у коментарях: без нього рахуються тільки кореневі
        // коментарі, а відповіді в гілках губляться.
        // Джерело беремо зі стрічки Сторінки, а не з video_reels: на вузлі
        // ролика поля reactions немає взагалі (Graph відповідає помилкою на
        // ВЕСЬ запит), а likes.summary рахує ЛИШЕ «подобається» — без «супер»,
        // «ого» й «сумно». Саме через це перший розбір занизив числа в кілька
        // разів. У дописі стрічки лічильник той самий, що бачить власник.
        // filter(stream) у коментарях додає відповіді в гілках.
        const SOURCES = [
          { edge: 'feed', fields: 'id,created_time,permalink_url,message,'
            + 'reactions.summary(true).limit(0),comments.summary(true).filter(stream).limit(0),shares' },
          { edge: 'video_reels', fields: 'id,created_time,permalink_url,description,'
            + 'likes.summary(true).limit(0),comments.summary(true).limit(0)' },
        ];
        const reels = [];
        const notes = [];
        let next = null;
        for (const s of SOURCES) {
          const probe = `${base}/${encodeURIComponent(pageId)}/${s.edge}?fields=${s.fields}&limit=50&${auth}`;
          const data = await (await fetch(probe)).json();
          if (data.error) { notes.push(`${s.edge}: ${data.error.message}`); continue; }
          next = probe;
          break;
        }
        if (!next) return json(res, 200, { count: 0, notes, reels: [] });

        while (next && reels.length < limit) {
          const data = await (await fetch(next)).json();
          if (data.error) { notes.push(`list: ${data.error.message}`); break; }
          for (const v of data.data || []) {
            reels.push({
              id: v.id,
              created: v.created_time || null,
              permalink: v.permalink_url && v.permalink_url.startsWith('http')
                ? v.permalink_url : `https://www.facebook.com${v.permalink_url || ''}`,
              // reactions — усі реакції разом; likes лишається як запасний
              // варіант для вузла video_reels, де reactions немає.
              reactions: v.reactions?.summary?.total_count ?? v.likes?.summary?.total_count ?? null,
              comments: v.comments?.summary?.total_count ?? null,
              shares: v.shares?.count ?? null,
              text: String(v.message || v.description || '').replace(/\s+/g, ' ').trim(),
            });
          }
          next = data.paging?.next || null;
        }

        // 2) Метрики переглядів — пачками, щоб не впертися в ліміт частоти.
        const insights = async (id) => {
          for (const metric of METRIC_SETS) {
            const data = await (await fetch(`${base}/${encodeURIComponent(id)}/video_insights?metric=${metric}&${auth}`)).json();
            if (data.error) continue;
            const out = {};
            for (const m of data.data || []) out[m.name] = m.values?.[0]?.value ?? m.value ?? null;
            if (Object.keys(out).length) return out;
          }
          return {};
        };
        for (let i = 0; i < reels.length; i += 8) {
          const chunk = reels.slice(i, i + 8);
          const got = await Promise.all(chunk.map((r) => insights(r.id).catch(() => ({}))));
          chunk.forEach((r, k) => {
            const m = got[k];
            r.views = m.blue_reels_play_count ?? m.total_video_views ?? null;
            r.avgWatchMs = m.post_video_avg_time_watched ?? null;
            r.watchTimeMs = m.post_video_view_time ?? m.total_video_view_total_time ?? null;
          });
        }

        return json(res, 200, { count: reels.length, notes, reels });
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
      // ?gain=3 — поправка рівня в дБ; разом із нею відео копіюється як є.
      const gainDb = Number(url.searchParams.get('gain')) || 0;
      try {
        return json(res, 200, await remuxVideoToSpec(id, { gainDb, copyVideo: gainDb !== 0 }));
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    // Ручний прогін перевірки коментарів — щоб не чекати чверть години.
    if (req.method === 'GET' && pathname === '/api/comments/rethink') {
      try {
        return json(res, 200, await rethinkSkipped());
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    if (req.method === 'GET' && pathname === '/api/comments/cleanup') {
      try {
        return json(res, 200, await cleanupStale());
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    if (req.method === 'GET' && pathname === '/api/comments/state') {
      try {
        return json(res, 200, await pendingSummary());
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    if (req.method === 'GET' && pathname === '/api/comments') {
      try {
        return json(res, 200, await checkAll());
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    // Розклад публікацій по платформах + що з нього вже відпрацювало сьогодні.
    // Мінідодаток показує це згорнутим блоком: власник хоче бачити картину дня,
    // не гортаючи чергу.
    //
    // «Сьогодні опубліковано» рахуємо за appProperties самого MP4
    // (<платформа>PublishedAt) — це єдине надійне джерело: таблиця про
    // автопублікацію нічого не знає, там дата з'являється лише після ручного
    // натискання «Опубліковано».
    if (req.method === 'GET' && pathname === '/api/schedule') {
      try {
        const today = kyivToday();
        const nowMinutes = kyivMinutes();
        const files = await listVideoFiles().catch(() => new Map());
        // Година кожної сьогоднішньої публікації, по платформах. Рахувати
        // КІЛЬКІСТЬ постів і гасити стільки ж перших вікон не можна: вікно
        // легко пропускається (4 серпня Instagram вийшов об 11:00 і 16:00, а
        // 19:00 лишилося порожнім), і тоді позначки з'їхали б.
        const doneHours = {};
        for (const file of files.values()) {
          for (const [key, value] of Object.entries(file.appProperties || {})) {
            const match = /^(\w+)PublishedAt$/.exec(key);
            if (!match || !value) continue;
            const at = new Date(value);
            // ISO-мітка в UTC; порівнюємо саме київську дату, інакше вечірні
            // пости після 21:00 UTC рахувалися б завтрашніми.
            if (Number.isNaN(at.getTime()) || kyivToday(at) !== today) continue;
            (doneHours[match[1]] ??= []).push(Math.floor(kyivMinutes(at) / 60));
          }
        }
        // Facebook свідомо не в автопублікації (див. коментар в autopublish.js):
        // бот лише нагадує, а публікує власник руками.
        const manual = new Set(['facebook']);
        const platforms = availablePlatforms()
          .filter((p) => p.enabled || manual.has(p.id))
          .map((p) => {
            const hours = platformHours(p.id);
            const posted = doneHours[p.id] ?? [];
            return {
              id: p.id,
              name: p.name,
              manual: manual.has(p.id),
              hours,
              // Слот живе дві години, тож пост о 16:01 і о 17:40 однаково
              // належать вікну 16:00.
              done: hours.filter((h) => posted.some((x) => x === h || x === h + 1)),
              next: hours.find((h) => h * 60 > nowMinutes) ?? null,
            };
          });
        return json(res, 200, { today, platforms });
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
            tiktok: f.appProperties.tiktokPostId || null,
            youtube: f.appProperties.youtubePostId || null,
            youtubeAt: f.appProperties.youtubePublishedAt || null,
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
        // Мітки на кожну платформу окремо: з роздільним розкладом у файлі
        // лежить autoSlotYoutube, autoSlotTiktok тощо, і лишити хоч одну
        // означало б, що ця платформа більше ніколи не візьме ролик у чергу.
        const perPlatform = {};
        for (const platform of ['facebook', 'instagram', 'tiktok', 'youtube']) {
          const key = claimProperty(platform);
          perPlatform[key] = null;
          perPlatform[`${key}Notified`] = null;
          perPlatform[`${key}ErrNotified`] = null;
          perPlatform[`${key}At`] = null;
          perPlatform[`${platform}PostId`] = null;
          perPlatform[`${platform}PublishedAt`] = null;
        }
        const cleared = await setVideoAppProperties(file.id, {
          ...perPlatform,
          autoPostSlot: null,
          autoPostItemId: null,
          autoPostDone: null,
          autoPostNotified: null,
          autoPostLastAttemptAt: null,
          facebookRemindedAt: null,
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
            + 'Рядок у таблиці зі статусом NEW.\n\n'
            + '1. Відкрий ChatGPT і встав промт із колонки G цього рядка — він '
            + 'розіб\'є текст на слайди й перевірить факти.\n'
            + '2. Перечитай і поправ тексти тут, у мінідодатку.\n'
            + '3. Аж потім запускай промт малювання фото.',
          ).catch(() => {});
          return json(res, 200, out);
        }
        if (step === 'surname') {
          const out = await submitSurname({ surname: body.surname });
          cache.at = 0;
          await sendMessage(
            ownerChatId(),
            `🧬 Замовлення прийнято: ${out.surname}\n`
            + `Рядок ${out.id} у таблиці зі статусом NEW.\n\n`
            + 'Наступний запуск завдання ChatGPT візьме його першим — '
            + 'замовлення мають пріоритет над темами з ротації.',
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

    // Що саме дозволяє нинішній токен Google і чий це акаунт.
    if (req.method === 'GET' && pathname === '/api/google/scopes') {
      try {
        return json(res, 200, await tokenScopes());
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    // Чи бачить наш токен канал YouTube і чи вистачає йому прав. Найчастіша
    // причина помилки — refresh-токен, виданий до додавання скоупу youtube:
    // права зашиті в токен, тож потрібна повторна згода через /oauth/start.
    // Статистика всіх роликів каналу одним запитом — щоб порівнювати їх між
    // собою, а не переглядати по одному в Studio.
    if (req.method === 'GET' && pathname === '/api/youtube/stats') {
      try {
        const videos = await channelVideoStats();
        return json(res, 200, { count: videos.length, videos });
      } catch (error) {
        return json(res, 200, { error: error.message });
      }
    }

    if (req.method === 'GET' && pathname === '/api/youtube/check') {
      const out = {
        enabled: process.env.ENABLE_YOUTUBE === '1',
        google: googleStatus().mode,
        tokenSource: youtubeTokenSource(),
        privacyRequested: process.env.YOUTUBE_PRIVACY || 'public',
        aiLabel: process.env.YOUTUBE_AI_LABEL !== '0',
      };
      try {
        out.scopes = (await youtubeTokenScopes()).scopes.map((s) => s.split('/auth/')[1] || s);
        out.canReplyToComments = out.scopes.includes('youtube.force-ssl');
      } catch (e) {
        out.scopesError = e.message;
      }
      try {
        out.channel = await channelInfo();
        if (!out.channel) out.error = 'цей акаунт не має каналу YouTube — пройди /oauth/youtube/start з акаунта, якому належить канал';
      } catch (e) {
        out.error = e.message;
        if (/insufficient|scope|permission/i.test(e.message)) {
          out.hint = 'у токена немає прав YouTube — пройди /oauth/youtube/start з акаунта каналу і задай YOUTUBE_OAUTH_REFRESH_TOKEN';
        }
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

    // Окрема згода для YouTube — коли канал на іншому акаунті Google, ніж
    // Таблиця з Диском. Просить ЛИШЕ права YouTube, щоб випадкова згода з
    // чужого акаунта не могла підмінити доступ до Диска.
    if (req.method === 'GET' && pathname === '/oauth/youtube/start') {
      if (!oauthConfigured()) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h2>Спершу задай GOOGLE_OAUTH_CLIENT_ID і GOOGLE_OAUTH_CLIENT_SECRET у Railway.</h2>');
        return;
      }
      res.writeHead(302, { location: youtubeConsentUrl() });
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
        // state каже, яку саме згоду ми проходили: спільну чи лише YouTube.
        // Без цього легко вставити токен не в ту змінну й зламати Диск.
        const forYoutube = url.searchParams.get('state') === 'youtube';
        const variable = forYoutube ? 'YOUTUBE_OAUTH_REFRESH_TOKEN' : 'GOOGLE_OAUTH_REFRESH_TOKEN';
        res.end(
          '<div style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6">' +
          `<h2>✅ Готово${forYoutube ? ' — токен YouTube' : ''}!</h2>` +
          `<p>Скопіюй цей <b>refresh token</b> і встав у Railway як змінну <code>${variable}</code>, потім збережи (буде редеплой):</p>` +
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
          // Саме ті години, за якими живе автопублікація. Раніше тут стояв
          // зашитий список ['10:00','18:00'] — діагностика показувала його
          // навіть тоді, коли AUTO_PUBLISH_HOURS давно був інший, і збивала
          // з пантелику під час розбору «чому не опублікувалось».
          schedule: publishHours().map((h) => `${String(h).padStart(2, '0')}:00`),
          // Розклад кожної платформи окремо — щоб було видно, що куди й коли.
          perPlatform: Object.fromEntries(
            ['youtube', 'tiktok', 'instagram', 'facebook'].map((platform) => [
              platform,
              platformHours(platform).map((h) => `${String(h).padStart(2, '0')}:00`),
            ]),
          ),
          facebookReminder: process.env.ENABLE_FB_REMINDER === '1',
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
    // Кнопки під картками коментарів працюють лише поки хтось читає оновлення
    // Telegram, тож цикл стартує разом зі спостерігачем, а не окремо.
    // Платформи реєструються лише ті, які ввімкнені: адаптер без токена лише
    // сипав би помилками кожні чверть години.
    if (process.env.ENABLE_YT_COMMENTS === '1') registerPlatform(youtubeAdapter);
    if (process.env.ENABLE_FB_COMMENTS === '1') registerPlatform(facebookAdapter);
    if (process.env.ENABLE_IG_COMMENTS === '1') registerPlatform(instagramAdapter);
    if (process.env.ENABLE_YT_COMMENTS === '1'
      || process.env.ENABLE_FB_COMMENTS === '1'
      || process.env.ENABLE_IG_COMMENTS === '1') {
      startTelegramLoop();
      startCommentWatcher();
    }
  } else {
    console.warn('GOOGLE_SERVICE_ACCOUNT_JSON не задано — монітор черги вимкнено (немає доступу до таблиці).');
  }
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Веб-панель вимкнена. Запусти з ENABLE_WEB=1, щоб увімкнути.');
}

export { server, verifyInitData, videoResponseHeaders };
