// Публікація Reels через офіційний Meta Graph API.
// Один Page access token використовується і для Facebook Page, і для
// пов'язаного Instagram professional account.

const DEFAULT_GRAPH_VERSION = 'v25.0';
const DEFAULT_IG_POLL_MS = 5_000;
const DEFAULT_IG_MAX_POLLS = 60;

function graphVersion() {
  return process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
}

function graphBase() {
  return `https://graph.facebook.com/${graphVersion()}`;
}

function metaError(body, status) {
  const error = body?.error;
  if (!error) return `Meta API HTTP ${status}`;
  const suffix = [error.code && `code ${error.code}`, error.error_subcode && `subcode ${error.error_subcode}`]
    .filter(Boolean)
    .join(', ');
  return `${error.message || `Meta API HTTP ${status}`}${suffix ? ` (${suffix})` : ''}`;
}

async function responseJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; }
  catch { return { raw: text }; }
}

async function requestJson(url, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, options);
  const body = await responseJson(response);
  if (!response.ok || body?.error) {
    throw new Error(metaError(body, response.status));
  }
  return body;
}

async function graphRequest(path, {
  method = 'GET', params = {}, token, fetchImpl = fetch,
} = {}) {
  if (!token) throw new Error('META_PAGE_ACCESS_TOKEN не задано');
  const url = new URL(`${graphBase()}/${String(path).replace(/^\/+/, '')}`);
  const values = { ...params, access_token: token };
  const options = { method };

  if (method === 'GET') {
    for (const [key, value] of Object.entries(values)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
  } else {
    options.headers = { 'content-type': 'application/x-www-form-urlencoded' };
    options.body = new URLSearchParams(
      Object.entries(values)
        .filter(([, value]) => value != null)
        .map(([key, value]) => [key, String(value)]),
    );
  }

  return requestJson(url, options, fetchImpl);
}

function required(value, name) {
  if (!String(value || '').trim()) throw new Error(`${name} не задано`);
  return String(value).trim();
}

function publicVideoUrl(value) {
  const url = required(value, 'Публічне посилання на відео');
  if (!url.startsWith('https://')) {
    throw new Error('Meta може завантажити відео лише з публічного HTTPS-посилання');
  }
  return url;
}

export function facebookConfigured() {
  return Boolean(process.env.META_PAGE_ID && process.env.META_PAGE_ACCESS_TOKEN);
}

export function instagramConfigured() {
  return Boolean(process.env.META_IG_USER_ID && process.env.META_PAGE_ACCESS_TOKEN);
}

export function metaStatus() {
  return {
    graphVersion: graphVersion(),
    facebookConfigured: facebookConfigured(),
    instagramConfigured: instagramConfigured(),
    facebookEnabled: process.env.ENABLE_FB === '1',
    instagramEnabled: process.env.ENABLE_IG === '1',
  };
}

async function waitForInstagramContainer(containerId, {
  token,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = Number(process.env.META_IG_POLL_MS) || DEFAULT_IG_POLL_MS,
  maxPolls = Number(process.env.META_IG_MAX_POLLS) || DEFAULT_IG_MAX_POLLS,
} = {}) {
  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    const status = await graphRequest(encodeURIComponent(containerId), {
      params: { fields: 'status_code,status' }, token, fetchImpl,
    });
    if (status.status_code === 'FINISHED') return status;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new Error(`Instagram не підготував Reel: ${status.status || status.status_code}`);
    }
    if (attempt < maxPolls) await sleep(pollMs);
  }
  throw new Error('Instagram занадто довго обробляє відео — спроба буде повторена');
}

export async function publishInstagramReel({ videoUrl, caption }, options = {}) {
  const token = options.token || process.env.META_PAGE_ACCESS_TOKEN;
  const igUserId = required(options.igUserId || process.env.META_IG_USER_ID, 'META_IG_USER_ID');
  const source = publicVideoUrl(videoUrl);

  const container = await graphRequest(`${encodeURIComponent(igUserId)}/media`, {
    method: 'POST',
    params: {
      media_type: 'REELS',
      video_url: source,
      caption: String(caption || ''),
      share_to_feed: 'true',
      // Самодекларація ШІ-контенту: кадри малює нейромережа, тож Instagram
      // має показати позначку «AI info». Ставимо завжди, крім явного
      // META_AI_LABEL=0 — краще позначити зайвий раз, ніж отримати
      // приховане зниження охоплення за недекларований ШІ.
      ...(process.env.META_AI_LABEL === '0' ? {} : { is_ai_generated: 'true' }),
    },
    token,
    fetchImpl: options.fetchImpl,
  });
  if (!container.id) throw new Error('Instagram не повернув ID медіаконтейнера');

  await waitForInstagramContainer(container.id, {
    token,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    pollMs: options.pollMs,
    maxPolls: options.maxPolls,
  });

  const published = await graphRequest(`${encodeURIComponent(igUserId)}/media_publish`, {
    method: 'POST',
    params: { creation_id: container.id },
    token,
    fetchImpl: options.fetchImpl,
  });
  if (!published.id) throw new Error('Instagram не повернув ID опублікованого Reel');
  return { id: String(published.id), containerId: String(container.id) };
}

export async function publishFacebookReel({ videoUrl, description }, options = {}) {
  const token = required(options.token || process.env.META_PAGE_ACCESS_TOKEN, 'META_PAGE_ACCESS_TOKEN');
  const pageId = required(options.pageId || process.env.META_PAGE_ID, 'META_PAGE_ID');
  const source = publicVideoUrl(videoUrl);
  const fetchImpl = options.fetchImpl || fetch;

  const started = await graphRequest(`${encodeURIComponent(pageId)}/video_reels`, {
    method: 'POST', params: { upload_phase: 'start' }, token, fetchImpl,
  });
  if (!started.video_id || !started.upload_url) {
    throw new Error('Facebook не повернув video_id або upload_url для Reel');
  }

  const transferred = await requestJson(started.upload_url, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${token}`,
      file_url: source,
    },
  }, fetchImpl);
  if (transferred.success === false) throw new Error('Facebook не прийняв файл Reel');

  // is_ai_generated немає в посібнику «Publish a Reel» — його таблиця параметрів
  // обриваються на video_state/description. Параметр описаний лише в довіднику
  // Graph API для ребра /{page-id}/video_reels: «A boolean flag for developers
  // to self-claim whether the video was created with AI». Це той самий
  // перемикач «Додати значок ШІ», що видно при ручній публікації; без нього
  // Facebook вважає ролик недекларованим ШІ-контентом і може тихо, без жодної
  // помилки в API, обмежити його показ.
  const finished = await graphRequest(`${encodeURIComponent(pageId)}/video_reels`, {
    method: 'POST',
    params: {
      upload_phase: 'finish',
      video_id: started.video_id,
      video_state: 'PUBLISHED',
      description: String(description || ''),
      ...(process.env.META_AI_LABEL === '0' ? {} : { is_ai_generated: 'true' }),
    },
    token,
    fetchImpl,
  });
  if (finished.success === false) throw new Error('Facebook не опублікував Reel');
  return { id: String(started.video_id) };
}

export { graphRequest, waitForInstagramContainer };
