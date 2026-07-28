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

// YouTube ріже назву на 100 символах і не приймає < та >.
function cleanTitle(value) {
  const text = String(value || '').replace(/[<>]/g, '').trim();
  if (!text) throw new Error('YouTube: порожня назва ролика');
  return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : text;
}

// Хештег #Shorts. Технічно він не обов'язковий: YouTube відносить ролик до
// Shorts сам, за вертикальним кадром і тривалістю до 3 хвилин. Але він
// допомагає класифікації й пошуку, тож додаємо.
//
// Чому тут, а не в промті ChatGPT: опис у таблиці ОДИН на всі платформи, і в
// TikTok, Instagram та Facebook цей хештег був би зайвим сміттям. Дописуємо
// його на льоту лише для YouTube. Вимикається через YOUTUBE_SHORTS_TAG=0.
export function withShortsTag(description) {
  const text = String(description || '').trim();
  if (process.env.YOUTUBE_SHORTS_TAG === '0') return text;
  if (/#shorts\b/i.test(text)) return text; // вже є — не дублюємо
  return text ? `${text} #Shorts` : '#Shorts';
}

// Теги беремо з хештегів опису — окремого поля для них у таблиці немає, а
// дублювати роботу вручну немає сенсу. YouTube обмежує суму тегів 500 символами.
export function tagsFromDescription(description) {
  const found = String(description || '').match(/#[^\s#]+/g) || [];
  const tags = [];
  let total = 0;
  for (const raw of found) {
    const tag = raw.slice(1);
    if (!tag || tags.includes(tag)) continue;
    if (total + tag.length + 1 > 500) break;
    tags.push(tag);
    total += tag.length + 1;
  }
  return tags;
}

// Заливає ролик. videoBuffer — готовий MP4.
// Повертає { id, privacyStatus, uploadStatus, requestedPrivacy, forcedPrivate }.
export async function publishYouTubeShort({ videoBuffer, title, description }, options = {}) {
  const buffer = Buffer.isBuffer(videoBuffer) ? videoBuffer : Buffer.from(videoBuffer || '');
  if (!buffer.length) throw new Error('YouTube: порожній файл відео');

  const requestedPrivacy = process.env.YOUTUBE_PRIVACY || 'public';
  const client = options.client || youtube();
  const text = withShortsTag(description);

  const res = await client.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: cleanTitle(title),
        description: text.slice(0, DESCRIPTION_LIMIT),
        tags: tagsFromDescription(text),
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
