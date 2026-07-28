// Адаптер коментарів для YouTube.
//
// Уся механіка (чернетки, картки з кнопками, стан, ручне редагування) живе в
// comment-flow.js — тут лише те, чим YouTube відрізняється: як дістати нові
// коментарі й як опублікувати відповідь.
import { google } from 'googleapis';
import { youtubeAuth } from './google-auth.js';

// Перевикспорт для сумісності: тести й старі виклики беруть їх звідси.
export { draftPrompt, draftReply } from './comment-flow.js';

let api = null;
function youtube() {
  if (!api) api = google.youtube({ version: 'v3', auth: youtubeAuth() });
  return api;
}

export function youtubeEnabled() {
  return Boolean(process.env.YOUTUBE_OAUTH_REFRESH_TOKEN || process.env.GOOGLE_OAUTH_REFRESH_TOKEN);
}

async function channelId(client) {
  if (process.env.YOUTUBE_CHANNEL_ID) return process.env.YOUTUBE_CHANNEL_ID;
  const res = await client.channels.list({ part: ['id'], mine: true });
  const id = res.data?.items?.[0]?.id;
  if (!id) throw new Error('YouTube: токен не бачить жодного каналу');
  return id;
}

// Свіжі коментарі верхнього рівня з усіх роликів каналу.
export async function fetchComments(options = {}) {
  const client = options.client || youtube();
  const mine = options.channelId || await channelId(client);
  const res = await client.commentThreads.list({
    part: ['snippet'],
    allThreadsRelatedToChannelId: mine,
    order: 'time',
    maxResults: Number(options.maxResults) || 20,
    textFormat: 'plainText',
  });
  return (res.data?.items || []).map((item) => {
    const top = item.snippet?.topLevelComment;
    return {
      id: top?.id,
      text: top?.snippet?.textOriginal || '',
      author: top?.snippet?.authorDisplayName || '—',
      authorChannelId: top?.snippet?.authorChannelId?.value || '',
      videoId: item.snippet?.videoId || '',
      publishedAt: top?.snippet?.publishedAt || '',
    };
  }).filter((c) => c.id && c.authorChannelId !== mine); // свої ж відповіді пропускаємо
}

export async function publishReply(commentId, text, options = {}) {
  const client = options.client || youtube();
  const res = await client.comments.insert({
    part: ['snippet'],
    requestBody: { snippet: { parentId: commentId, textOriginal: String(text).trim() } },
  });
  return res.data?.id || null;
}

export const youtubeAdapter = {
  key: 'yt',
  label: 'YouTube',
  icon: '▶️',
  enabled: youtubeEnabled,
  fetch: fetchComments,
  reply: publishReply,
  link: (c) => `https://youtu.be/${c.videoId}`,
};
