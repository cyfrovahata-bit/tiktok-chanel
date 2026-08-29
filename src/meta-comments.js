// Адаптери коментарів для Facebook і Instagram.
//
// Обидві платформи живуть на тому самому токені Сторінки, але дозволи різні:
// читати чужі коментарі дає pages_read_user_content (НЕ pages_read_engagement —
// той лише про метрики), відповідати — pages_manage_engagement, а в Instagram
// усе разом робить instagram_manage_comments. Токен має бути саме Сторінки:
// користувацький бачить Instagram, але не бачить дописів Сторінки.
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
      // Вкладені comments — це відповіді на коментар. Потрібні, щоб не
      // пропонувати відповісти там, де Сторінка вже відповіла (байдуже,
      // ботом чи руками з телефона).
      // message самого допису потрібен, щоб знайти ролик: ID допису на файл
      // ніхто не записує (Facebook публікується вручну), а текст власник
      // копіює з мінідодатка — отже назва рядка стоїть у ньому дослівно.
      fields: 'id,message,created_time,comments.limit(25){id,message,created_time,from,comments.limit(10){from}}',
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
      const answered = (c.comments?.data || []).some((r) => r.from?.id === pageId);
      if (answered) continue;
      out.push({
        id: c.id,
        text: c.message,
        author: c.from?.name || 'Глядач',
        postId: post.id,
        postText: post.message || '',
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
      fields: 'id,permalink,comments.limit(25){id,text,timestamp,username,from,replies{username,from}}',
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
      // Наша відповідь у гілці означає, що питання вже закрите.
      const answered = (c.replies?.data || []).some((r) => (
        r.from?.id === igUserId || (own && String(r.username || '').toLowerCase() === own)
      ));
      if (answered) continue;
      out.push({
        id: c.id,
        text: c.text,
        author: c.username || 'глядач',
        // mediaId потрібен, щоб знайти рядок таблиці за appProperties відео й
        // дати моделі контекст ролика. permalink для цього не годиться.
        mediaId: media.id || '',
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
