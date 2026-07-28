// Адаптери коментарів для Facebook і Instagram.
//
// Обидві платформи живуть на тому самому токені Сторінки, але дозволи різні:
// Facebook потребує pages_manage_engagement, Instagram — instagram_manage_comments.
// Читати можна з pages_read_engagement, який у нас точно є, тож «бачу коментарі,
// але не можу відповісти» — цілком імовірний стан. Саме тому canReply() пробує
// саме ЗАПИС, а не вгадує за переліком дозволів: для токена Сторінки Graph його
// не показує.
import { graphRequest } from './meta.js';

const LIMIT = Number(process.env.META_COMMENTS_LIMIT) || 10;

function token() {
  const value = process.env.META_PAGE_ACCESS_TOKEN;
  if (!value) throw new Error('META_PAGE_ACCESS_TOKEN не задано');
  return value;
}

// --- Facebook ----------------------------------------------------------------

export function facebookEnabled() {
  return Boolean(process.env.META_PAGE_ID && process.env.META_PAGE_ACCESS_TOKEN);
}

// Коментарі під свіжими дописами Сторінки. Беремо саме всі дописи, а не лише
// опубліковані нами: автопублікацію у Facebook вимкнено, власник постить руками,
// і відповідати треба насамперед під тими дописами.
export async function fetchFacebookComments(options = {}) {
  const pageId = process.env.META_PAGE_ID;
  const data = await graphRequest(`${encodeURIComponent(pageId)}/posts`, {
    params: {
      fields: `id,created_time,comments.limit(25){id,message,created_time,from}`,
      limit: options.limit || LIMIT,
    },
    token: options.token || token(),
    fetchImpl: options.fetchImpl,
  });
  const out = [];
  for (const post of data.data || []) {
    for (const c of post.comments?.data || []) {
      // Свої ж відповіді пропускаємо, інакше бот відповідатиме сам собі.
      if (!c.id || !c.message || c.from?.id === pageId) continue;
      out.push({
        id: c.id,
        text: c.message,
        author: c.from?.name || 'Глядач',
        postId: post.id,
        publishedAt: c.created_time || '',
      });
    }
  }
  return out;
}

export function replyFacebook(commentId, message, options = {}) {
  return graphRequest(`${encodeURIComponent(commentId)}/comments`, {
    method: 'POST',
    params: { message: String(message).trim() },
    token: options.token || token(),
    fetchImpl: options.fetchImpl,
  });
}

export const facebookAdapter = {
  key: 'fb',
  label: 'Facebook',
  icon: '💬',
  enabled: facebookEnabled,
  fetch: fetchFacebookComments,
  reply: replyFacebook,
  link: (c) => `https://www.facebook.com/${c.postId}`,
};

// --- Instagram ---------------------------------------------------------------

export function instagramEnabled() {
  return Boolean(process.env.META_IG_USER_ID && process.env.META_PAGE_ACCESS_TOKEN);
}

export async function fetchInstagramComments(options = {}) {
  const igUserId = process.env.META_IG_USER_ID;
  const data = await graphRequest(`${encodeURIComponent(igUserId)}/media`, {
    params: {
      fields: 'id,permalink,comments.limit(25){id,text,timestamp,username,from}',
      limit: options.limit || LIMIT,
    },
    token: options.token || token(),
    fetchImpl: options.fetchImpl,
  });
  const own = String(process.env.META_IG_USERNAME || '').toLowerCase();
  const out = [];
  for (const media of data.data || []) {
    for (const c of media.comments?.data || []) {
      if (!c.id || !c.text) continue;
      // Instagram не завжди віддає from, тож звіряємо ще й за іменем автора.
      if (c.from?.id === igUserId) continue;
      if (own && String(c.username || '').toLowerCase() === own) continue;
      out.push({
        id: c.id,
        text: c.text,
        author: c.username || 'глядач',
        permalink: media.permalink || '',
        publishedAt: c.timestamp || '',
      });
    }
  }
  return out;
}

export function replyInstagram(commentId, message, options = {}) {
  return graphRequest(`${encodeURIComponent(commentId)}/replies`, {
    method: 'POST',
    params: { message: String(message).trim() },
    token: options.token || token(),
    fetchImpl: options.fetchImpl,
  });
}

export const instagramAdapter = {
  key: 'ig',
  label: 'Instagram',
  icon: '📷',
  enabled: instagramEnabled,
  fetch: fetchInstagramComments,
  reply: replyInstagram,
  link: (c) => c.permalink || '',
};
