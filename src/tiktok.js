// Публікація Reels у TikTok через Content Posting API.
//
// Відео віддаємо СВОЇМИ БАЙТАМИ (source: FILE_UPLOAD), а не посиланням.
// PULL_FROM_URL вимагав би верифікації домену, з якого TikTok качає файл —
// наші ролики лежать на Railway, а застосунок верифіковано на іншому домені,
// тож це був би окремий біль. FILE_UPLOAD цього не потребує взагалі.
//
// Куди саме публікуємо, залежить від затвердженого скоупу — визначаємо його
// з відповіді самого TikTok, нічого не питаючи наперед:
//   video.publish → одразу в стрічку (/v2/post/publish/video/init/);
//   video.upload  → у чернетки застосунку (/v2/post/publish/inbox/video/init/),
//                   далі власник публікує сам у телефоні.
import { readTokens, writeTokens } from './tiktok-token.js';

const AUTH_BASE = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';
const SCOPES = 'user.info.basic,video.publish,video.upload';

function clientKey() {
  const v = process.env.TIKTOK_CLIENT_KEY;
  if (!v) throw new Error('Не задано TIKTOK_CLIENT_KEY');
  return v;
}
function clientSecret() {
  const v = process.env.TIKTOK_CLIENT_SECRET;
  if (!v) throw new Error('Не задано TIKTOK_CLIENT_SECRET');
  return v;
}
export function redirectUri() {
  const base = (process.env.PUBLIC_URL || 'https://tiktok-chanel-production.up.railway.app').replace(/\/$/, '');
  return process.env.TIKTOK_REDIRECT_URI || `${base}/tiktok/callback`;
}
export function tiktokConfigured() {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`TikTok: не JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  // TikTok кладе помилку в поле error навіть при HTTP 200.
  const err = data?.error;
  if (err && err.code && err.code !== 'ok') {
    throw new Error(`TikTok: ${err.code}${err.message ? ` — ${err.message}` : ''}`);
  }
  if (!res.ok) throw new Error(`TikTok: HTTP ${res.status} ${text.slice(0, 200)}`);
  return data;
}

// --- Авторизація -------------------------------------------------------------

export function consentUrl(state = 'tiktok') {
  const params = new URLSearchParams({
    client_key: clientKey(),
    scope: SCOPES,
    response_type: 'code',
    redirect_uri: redirectUri(),
    state,
  });
  return `${AUTH_BASE}?${params}`;
}

function storeFrom(data, previous = {}) {
  return {
    refreshToken: data.refresh_token || previous.refreshToken,
    accessToken: data.access_token,
    // Знімаємо хвилину із запасу, щоб не впертися в межу під час запиту.
    accessExpiresAt: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000).toISOString(),
    scope: data.scope || previous.scope || '',
    openId: data.open_id || previous.openId || '',
  };
}

// Обмін коду згоди на токени (крок після /tiktok/callback).
export async function exchangeCode(code) {
  const data = await apiJson(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: clientKey(),
      client_secret: clientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
    }),
  });
  return writeTokens(storeFrom(data));
}

// Свіжий access-токен. Оновлює за потреби й ОДРАЗУ зберігає новий
// refresh-токен: старий після оновлення вже недійсний.
export async function accessToken() {
  let stored = await readTokens();
  if (!stored) {
    const seed = process.env.TIKTOK_REFRESH_TOKEN;
    if (!seed) throw new Error('TikTok не авторизовано: відкрий /tiktok/start або задай TIKTOK_REFRESH_TOKEN');
    stored = { refreshToken: seed };
  }
  if (stored.accessToken && stored.accessExpiresAt && Date.parse(stored.accessExpiresAt) > Date.now()) {
    return stored;
  }
  const data = await apiJson(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: clientKey(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
    }),
  });
  return writeTokens(storeFrom(data, stored));
}

// --- Публікація --------------------------------------------------------------

// Які рівні приватності доступні автору. TikTok вимагає викликати це перед
// прямою публікацією, і саме звідси беремо допустимий privacy_level:
// у незатверджених застосунків доступний лише SELF_ONLY.
export async function creatorInfo(token) {
  const data = await apiJson(`${API}/post/publish/creator_info/query/`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
    },
  });
  return data.data || {};
}

function pickPrivacy(options) {
  const wanted = process.env.TIKTOK_PRIVACY_LEVEL || 'PUBLIC_TO_EVERYONE';
  const list = Array.isArray(options) ? options : [];
  if (list.includes(wanted)) return wanted;
  // Застосунок ще не пройшов аудит — TikTok дозволить лише приватне.
  return list[0] || 'SELF_ONLY';
}

// Заливає байти на виданий upload_url. Ролик у нас ~5 МБ, тож один шматок.
async function uploadBytes(uploadUrl, buffer) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(buffer.length),
      'content-range': `bytes 0-${buffer.length - 1}/${buffer.length}`,
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`TikTok: завантаження файлу не вдалося (HTTP ${res.status})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Чекає, доки TikTok обробить відео. Статуси різні для двох режимів:
// пряма публікація завершується PUBLISH_COMPLETE, чернетка — SEND_TO_USER_INBOX.
async function waitForPublish(token, publishId, { maxPolls = 20, pollMs = 5000, sleepFn = sleep } = {}) {
  for (let i = 0; i < maxPolls; i++) {
    await sleepFn(pollMs);
    const data = await apiJson(`${API}/post/publish/status/fetch/`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const status = data.data?.status;
    if (status === 'PUBLISH_COMPLETE' || status === 'SEND_TO_USER_INBOX') return data.data;
    if (status === 'FAILED') {
      throw new Error(`TikTok: обробка провалилась (${data.data?.fail_reason || 'без причини'})`);
    }
  }
  throw new Error('TikTok: відео не обробилось за відведений час');
}

// Публікує один ролик. videoBuffer — готовий MP4.
// Повертає { id, mode: 'direct'|'inbox', privacy }.
export async function publishTikTokVideo({ videoBuffer, title }, options = {}) {
  const tokens = options.tokens || await accessToken();
  const token = tokens.accessToken;
  const buffer = Buffer.isBuffer(videoBuffer) ? videoBuffer : Buffer.from(videoBuffer);
  if (!buffer.length) throw new Error('TikTok: порожній файл відео');

  // Пряма публікація можлива лише зі скоупом video.publish. Інакше кладемо
  // в чернетки — це краще, ніж падати з помилкою про права.
  const direct = String(tokens.scope || '').includes('video.publish');

  const source_info = {
    source: 'FILE_UPLOAD',
    video_size: buffer.length,
    chunk_size: buffer.length,
    total_chunk_count: 1,
  };

  let body;
  let endpoint;
  let privacy = null;
  if (direct) {
    const info = await creatorInfo(token);
    privacy = pickPrivacy(info.privacy_level_options);
    endpoint = `${API}/post/publish/video/init/`;
    body = {
      post_info: {
        title: String(title || '').slice(0, 2200),
        privacy_level: privacy,
        // Кадри малює нейромережа — позначаємо, як і в Instagram.
        is_aigc: process.env.TIKTOK_AI_LABEL === '0' ? false : true,
      },
      source_info,
    };
  } else {
    endpoint = `${API}/post/publish/inbox/video/init/`;
    body = { source_info };
  }

  const init = await apiJson(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  });
  const publishId = init.data?.publish_id;
  const uploadUrl = init.data?.upload_url;
  if (!publishId || !uploadUrl) throw new Error('TikTok: не повернув publish_id або upload_url');

  await uploadBytes(uploadUrl, buffer);
  await waitForPublish(token, publishId, options);
  return { id: String(publishId), mode: direct ? 'direct' : 'inbox', privacy };
}
