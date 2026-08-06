// Публікація Shorts на YouTube через Data API v3.
//
// ВАЖЛИВЕ ОБМЕЖЕННЯ GOOGLE. Ролики, залиті через videos.insert із проєкту,
// який не пройшов аудит відповідності YouTube API, примусово стають
// ПРИВАТНИМИ — незалежно від того, що ми передамо в status.privacyStatus.
// Це задокументована поведінка для всіх проєктів, створених після 28.07.2020,
// і обійти її з боку коду не можна. Тому ми завжди читаємо privacyStatus із
// ВІДПОВІДІ, а не з того, що просили: лише так видно реальний стан ролика.
// Після проходження аудиту той самий код почне публікувати публічно сам.
//
// Окремо: Shorts не має власного ендпоінта. YouTube визначає формат сам —
// вертикальне відео до 3 хвилин потрапляє в Shorts автоматично. Наші ролики
// 1080×1920 і ~25 секунд, тож нічого додатково позначати не треба.
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { youtubeAuth, googleStatus } from './google-auth.js';

// Освіта — найближча категорія для каналу фактів. Повний перелік залежить від
// регіону, тож лишаємо змінною на випадок, якщо схочеш іншу.
const DEFAULT_CATEGORY_ID = '27';
const TITLE_LIMIT = 100;
const DESCRIPTION_LIMIT = 5000;

let api = null;
function youtube() {
  if (!api) api = google.youtube({ version: 'v3', auth: youtubeAuth() });
  return api;
}

export function youtubeConfigured() {
  return googleStatus().mode === 'oauth' && googleStatus().ready;
}

const SHORTS_TAG = '#Shorts';

// Назва ролика: без < та >, не довша за 100 символів, із хештегом #Shorts у
// кінці. Хештег ставимо саме сюди, а не в опис і не в теги — так його видно
// одразу під роликом. Якщо назва довга, ріжемо саме назву, а не хештег:
// обрізаний хештег не спрацював би зовсім.
// Вимикається через YOUTUBE_SHORTS_TAG=0.
function cleanTitle(value) {
  const raw = String(value || '').replace(/[<>]/g, '').trim();
  if (!raw) throw new Error('YouTube: порожня назва ролика');
  const fit = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);

  if (!wantsShortsTag(raw)) return fit(raw, TITLE_LIMIT);
  return `${fit(raw, TITLE_LIMIT - SHORTS_TAG.length - 1)} ${SHORTS_TAG}`;
}

function wantsShortsTag(text) {
  return process.env.YOUTUBE_SHORTS_TAG !== '0' && !/#shorts\b/i.test(text);
}

// Опис іде як є, з таблиці, плюс той самий хештег у кінці.
export function withShortsTag(description) {
  const text = String(description || '').trim();
  if (!wantsShortsTag(text)) return text;
  return text ? `${text} ${SHORTS_TAG}` : SHORTS_TAG;
}

// Заливає ролик. videoBuffer — готовий MP4.
// Повертає { id, privacyStatus, uploadStatus, requestedPrivacy, forcedPrivate }.
export async function publishYouTubeShort({ videoBuffer, title, description }, options = {}) {
  const buffer = Buffer.isBuffer(videoBuffer) ? videoBuffer : Buffer.from(videoBuffer || '');
  if (!buffer.length) throw new Error('YouTube: порожній файл відео');

  const requestedPrivacy = process.env.YOUTUBE_PRIVACY || 'public';
  const client = options.client || youtube();

  const res = await client.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: cleanTitle(title),
        // Поле tags не заповнюємо навмисно — теги YouTube на видачу майже не
        // впливають, а дублювати ними хештеги опису це зайвий шум.
        description: withShortsTag(description).slice(0, DESCRIPTION_LIMIT),
        categoryId: process.env.YOUTUBE_CATEGORY_ID || DEFAULT_CATEGORY_ID,
      },
      status: {
        privacyStatus: requestedPrivacy,
        // Канал не дитячий; без явної відповіді YouTube не приймає завантаження.
        selfDeclaredMadeForKids: false,
        // Рідна ШІ-позначка YouTube — те саме, що is_ai_generated у Meta та
        // is_aigc у TikTok. Знімається лише явним YOUTUBE_AI_LABEL=0.
        containsSyntheticMedia: process.env.YOUTUBE_AI_LABEL !== '0',
      },
    },
    media: { body: Readable.from(buffer) },
  });

  const id = res.data?.id;
  if (!id) throw new Error('YouTube не повернув ID ролика');
  const privacyStatus = res.data.status?.privacyStatus || null;
  return {
    id: String(id),
    privacyStatus,
    uploadStatus: res.data.status?.uploadStatus || null,
    requestedPrivacy,
    // Ознака непройденого аудиту: просили публічно, отримали приватно.
    forcedPrivate: requestedPrivacy !== 'private' && privacyStatus === 'private',
  };
}

// Публічна статистика власних роликів: перегляди, лайки, коментарі, довжина.
// Вистачає скоупа youtube.readonly, який у токена вже є, тож повторна згода
// не потрібна. Глибші метрики — утримання, покази, CTR, джерела трафіку —
// живуть в окремому YouTube Analytics API і вимагають скоупа
// yt-analytics.readonly; він доданий до YOUTUBE_SCOPES, але почне діяти лише
// після повторного проходження /oauth/youtube/start (права зашиті в токен).
//
// Навіщо це тут. Порівнювати ролики між собою на око неможливо: 61 ролик,
// різні теми, різні дати. Один запит дає таблицю, на якій видно, що саме
// корелює з переглядами — тема, довжина, час публікації.
export async function channelVideoStats(options = {}) {
  const client = options.client || youtube();
  const channels = await client.channels.list({ part: ['contentDetails'], mine: true });
  const uploads = channels.data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];

  const ids = [];
  let pageToken;
  do {
    const page = await client.playlistItems.list({
      part: ['contentDetails'], playlistId: uploads, maxResults: 50, pageToken,
    });
    for (const item of page.data?.items ?? []) {
      if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId);
    }
    pageToken = page.data?.nextPageToken;
  } while (pageToken && ids.length < 500);

  const out = [];
  // videos.list бере не більше 50 id за раз.
  for (let i = 0; i < ids.length; i += 50) {
    const page = await client.videos.list({
      part: ['snippet', 'statistics', 'contentDetails'], id: ids.slice(i, i + 50),
    });
    for (const v of page.data?.items ?? []) {
      out.push({
        id: v.id,
        title: v.snippet?.title ?? null,
        publishedAt: v.snippet?.publishedAt ?? null,
        duration: v.contentDetails?.duration ?? null,
        privacy: v.status?.privacyStatus ?? null,
        views: Number(v.statistics?.viewCount ?? 0),
        likes: Number(v.statistics?.likeCount ?? 0),
        comments: Number(v.statistics?.commentCount ?? 0),
      });
    }
  }
  out.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  return out;
}

// Діагностика: чий канал бачить наш токен. Без цього незрозуміло, куди саме
// поллються ролики, якщо в акаунті кілька каналів.
export async function channelInfo(options = {}) {
  const client = options.client || youtube();
  const res = await client.channels.list({ part: ['snippet', 'statistics'], mine: true });
  const channel = res.data?.items?.[0];
  if (!channel) return null;
  return {
    id: channel.id,
    title: channel.snippet?.title || null,
    subscribers: channel.statistics?.subscriberCount || null,
    videos: channel.statistics?.videoCount || null,
  };
}
