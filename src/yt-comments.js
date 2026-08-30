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

// Скільки гілок за прохід можна догортати повністю. commentThreads віддає не
// більше п'яти вкладених реплік; довші гілки доводиться довантажувати окремим
// викликом. Кожен коштує одиницю квоти, тож ставимо стелю.
const REPLY_FETCH_MAX = Number(process.env.YT_COMMENTS_REPLY_FETCH) || 5;

function byTime(a, b) {
  return String(a.snippet?.publishedAt || '').localeCompare(String(b.snippet?.publishedAt || ''));
}

async function fetchReplies(client, parentId) {
  const res = await client.comments.list({
    part: ['snippet'],
    parentId,
    maxResults: 100,
    textFormat: 'plainText',
  });
  return res.data?.items || [];
}

// Свіжі коментарі з усіх роликів каналу — і верхнього рівня, і в гілках.
//
// Гілка дає РІВНО ОДНОГО кандидата: останню чужу репліку. Інакше на одну
// розмову прилітало б по три картки, і канал відповідав би тричі там, де
// досить раз. Уся розмова їде поруч контекстом, щоб відповідь трималася
// бесіди, а не одного коментаря з її середини.
export async function fetchComments(options = {}) {
  const client = options.client || youtube();
  const mine = options.channelId || await channelId(client);
  // part=replies потрібен, щоб побачити, чи ми вже відповідали в цій гілці.
  // Квота від цього не росте: виклик коштує 1 одиницю незалежно від частин.
  const res = await client.commentThreads.list({
    part: ['snippet', 'replies'],
    allThreadsRelatedToChannelId: mine,
    order: 'time',
    maxResults: Number(options.maxResults) || 20,
    textFormat: 'plainText',
  });

  const out = [];
  let expanded = 0;
  for (const item of res.data?.items || []) {
    const top = item.snippet?.topLevelComment;
    if (!top?.id) continue;
    const videoId = item.snippet?.videoId || '';

    let replies = [...(item.replies?.comments || [])];
    const total = Number(item.snippet?.totalReplyCount) || 0;
    if (total > replies.length && expanded < REPLY_FETCH_MAX) {
      expanded += 1;
      try {
        replies = await fetchReplies(client, top.id);
      } catch (error) {
        console.error('[comments:yt] гілку не догорнув:', error.message);
      }
    }
    // Порядок реплік API не гарантує, а нам потрібна саме ОСТАННЯ.
    replies.sort(byTime);

    const isOurs = (c) => c.snippet?.authorChannelId?.value === mine;
    const textOf = (c) => c.snippet?.textOriginal || c.snippet?.textDisplay || '';
    const nameOf = (c) => c.snippet?.authorDisplayName || 'Глядач';

    const ours = replies.filter(isOurs);
    const answered = ours.length > 0;
    const lastOursAt = answered ? String(ours[ours.length - 1].snippet?.publishedAt || '') : '';

    // Верхній рівень — доки канал у цій гілці не писав.
    if (!isOurs(top) && textOf(top) && !answered) {
      out.push({
        id: top.id,
        text: textOf(top),
        author: nameOf(top),
        videoId,
        publishedAt: top.snippet?.publishedAt || '',
      });
    }

    const foreign = replies.filter((r) => r.id && !isOurs(r) && textOf(r));
    // Уже відповідали — беремо лише те, що з'явилося ПІСЛЯ нашої репліки.
    const after = answered
      ? foreign.filter((r) => String(r.snippet?.publishedAt || '') > lastOursAt)
      : foreign;
    const last = after[after.length - 1];
    if (!last) continue;

    out.push({
      id: last.id,
      text: textOf(last),
      author: nameOf(last),
      videoId,
      publishedAt: last.snippet?.publishedAt || '',
      parentId: top.id,
      // YouTube, як і Facebook, має рівно два рівні: відповідь публікується на
      // верхній коментар гілки, а до потрібної людини звертаємось на ім'я.
      replyTo: top.id,
      parentAuthor: nameOf(top),
      parentText: textOf(top),
      threadAnswered: answered,
      thread: replies.filter((r) => textOf(r)).map((r) => ({
        author: isOurs(r) ? 'Канал' : nameOf(r),
        text: textOf(r),
        ours: isOurs(r),
      })),
    });
  }
  return out;
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
