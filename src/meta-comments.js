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

// Догортаємо коментарі й відповіді; історія не обмежена першим вкладеним пакетом.
async function expandThreads(posts, edge, options) {
  const fields = edge === 'comments'
    ? 'id,message,created_time,from,attachment'
    : 'id,text,timestamp,username,from';
  async function expand(connection, path, queryFields) {
    if (!connection) return;
    const visited = new Set();
    for (let page = 0; page < 20 && connection.paging?.next; page += 1) {
      const after = connection.paging?.cursors?.after;
      if (!after || visited.has(after)) break;
      visited.add(after);
      const next = await graphRequest(path, { params: { fields: queryFields, limit: 100, after },
        token: options.token || token(), fetchImpl: options.fetchImpl });
      connection.data = [...(connection.data || []), ...(next.data || [])];
      connection.paging = next.paging;
    }
    if (connection.paging?.next) throw new Error('Meta: не вдалося догортати весь список коментарів');
  }
  for (const post of posts) {
    await expand(post.comments, `${encodeURIComponent(post.id)}/comments`,
      `${fields},${edge}.limit(100){${fields}}`);
    for (const c of post.comments?.data || []) {
      await expand(c[edge], `${encodeURIComponent(c.id)}/${edge}`, fields);
    }
  }
}

// --- Facebook ----------------------------------------------------------------

export function facebookEnabled() {
  return Boolean(process.env.META_PAGE_ID && process.env.META_PAGE_ACCESS_TOKEN);
}

// Коментарі під свіжими дописами Сторінки. Беремо саме всі дописи, а не лише
// опубліковані нами: автопублікацію у Facebook вимкнено, власник постить руками,
// і відповідати треба насамперед під тими дописами.
// deep=true — глибокий обхід: ідемо сторінками аж до META_COMMENTS_DEEP_MAX
// дописів. Так забираємо коментарі під старими роликами, куди звичайний прохід
// не зазирає. Робити це щочверть години немає сенсу: майже всі коментарі
// приходять під свіжими дописами, а повний обхід історії — це десятки
// звернень до Graph API щоразу.
export async function fetchFacebookComments(options = {}) {
  const pageId = process.env.META_PAGE_ID;
  const pageSize = options.limit || LIMIT;
  const maxPosts = options.deep
    ? (Number(process.env.META_COMMENTS_DEEP_MAX) || 200)
    : pageSize;

  const out = [];
  let after = options.after || null;
  let scanned = 0;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchPostsPage(pageId, { pageSize, after, options });
    await expandThreads(page.data || [], 'comments', options);
    scanned += collectFromPosts(page.data || [], pageId, out, options);
    options.onPage?.({ count: (page.data || []).length, next: page.paging?.next ? page.paging?.cursors?.after || null : null });
    after = options.deep ? page.paging?.cursors?.after || null : null;
  } while (!options.history && after && scanned < maxPosts);
  return out;
}

function fetchPostsPage(pageId, { pageSize, after, options }) {
  return graphRequest(`${encodeURIComponent(pageId)}/posts`, {
    params: {
      ...(after ? { after } : {}),
      // Вкладені comments — це відповіді на коментар. Потрібні, щоб не
      // пропонувати відповісти там, де Сторінка вже відповіла (байдуже,
      // ботом чи руками з телефона).
      // message самого допису потрібен, щоб знайти ролик: ID допису на файл
      // ніхто не записує (Facebook публікується вручну), а текст власник
      // копіює з мінідодатка — отже назва рядка стоїть у ньому дослівно.
      // attachment у коментарях — заради стікерів і картинок. Такий коментар
      // приходить із порожнім message, і без цього поля він для нас просто не
      // існував: ані картки, ані відповіді. А під дописами їх багато.
      fields: 'id,message,created_time,comments.limit(25)'
        + '{id,message,created_time,from,attachment,comments.limit(15)'
        + '{id,message,created_time,from,attachment}}',
      limit: pageSize,
    },
    token: options.token || token(),
    fetchImpl: options.fetchImpl,
  });
}

// Коментар-реакція: тексту немає, але є вкладення — стікер, гіф або картинка.
// Facebook віддає їх однаково, з типом усередині attachment. Розрізняти типи
// нам ні до чого: зміст усіх однаковий — «мені сподобалось».
export function isSticker(comment) {
  if (String(comment?.message || '').trim()) return false;
  const a = comment?.attachment;
  return Boolean(a && (a.type || a.url || a.media || a.target));
}

// Розбирає одну сторінку дописів у список коментарів. Повертає, скільки
// дописів переглянули — за цим лічильником зупиняється глибокий обхід.
function collectFromPosts(posts, pageId, out, options = {}) {
  for (const post of posts) {
    const common = { postId: post.id, postText: post.message || '' };
    for (const c of post.comments?.data || []) {
      // Свої ж коментарі пропускаємо, інакше бот відповідатиме сам собі.
      if (!c.id || c.from?.id === pageId) continue;

      const raw = [...(c.comments?.data || [])].sort((a, b) => String(a.created_time || '').localeCompare(String(b.created_time || '')));
      const snapshot = { ...common, id: c.id, text: c.message || '', author: c.from?.name || 'Глядач', publishedAt: c.created_time || '',
        thread: raw.map(r => ({ id: r.id, author: r.from?.id === pageId ? 'Канал' : (r.from?.name || 'Глядач'), text: r.message || '', ours: r.from?.id === pageId, publishedAt: r.created_time || '' })) };
      options.onThread?.(snapshot);
      // «Чи ми вже писали» рахуємо по ВСІХ відповідях, а не лише по тих, що
      // мають id: відповідь без id — це все одно наша відповідь, і пропустити
      // її означало б написати в гілку вдруге.
      const ours = raw.filter((r) => r.from?.id === pageId);
      const replies = raw.filter((r) => r.id);
      const answered = ours.length > 0;
      const lastOursAt = answered ? ours[ours.length - 1].created_time || '' : '';

      // Верхній рівень: як і раніше — доки Сторінка тут не писала.
      // Коментар без тексту, але зі стікером чи картинкою, теж беремо: це
      // реакція, і відповідь на неї потрібна така сама проста.
      if ((c.message || isSticker(c)) && !answered) {
        out.push({
          ...common,
          id: c.id,
          text: c.message || '',
          sticker: !c.message && isSticker(c),
          author: c.from?.name || 'Глядач',
          publishedAt: c.created_time || '',
          thread: snapshot.thread,
        });
      }

      // Гілка. Беремо ОДНОГО кандидата на гілку — останню чужу репліку, — а
      // всю розмову передаємо контекстом. Інакше на одну гілку прилітало б по
      // три картки, і бот відповідав би тричі там, де досить раз.
      const foreign = replies.filter((r) => r.from?.id !== pageId && (r.message || isSticker(r)));
      const after = answered
        // Ми вже писали в цю гілку. Далі втручаємось, лише якщо звертаються до
        // каналу — це вирішує модель, тож підсовуємо їй тільки нове.
        ? foreign.filter((r) => (r.created_time || '') > lastOursAt)
        : foreign;
      const last = after[after.length - 1];
      if (!last) continue;

      out.push({
        ...common,
        id: last.id,
        text: last.message || '',
        sticker: !last.message && isSticker(last),
        author: last.from?.name || 'Глядач',
        publishedAt: last.created_time || '',
        parentId: c.id,
        // Facebook приймає відповідь ЛИШЕ на верхній коментар: рівнів у нього
        // два, і POST на ID вкладеної репліки повертає «Unsupported post
        // request». Тому відповідаємо в гілку через її верхній коментар, а до
        // потрібної людини звертаємось на ім'я в самому тексті.
        replyTo: c.id,
        parentAuthor: c.from?.name || 'Глядач',
        parentText: c.message || '',
        threadAnswered: answered,
        thread: replies
          .filter((r) => r.message)
          .map((r) => ({
            id: r.id, publishedAt: r.created_time || '',
            author: r.from?.id === pageId ? 'Канал' : (r.from?.name || 'Глядач'),
            text: r.message,
            ours: r.from?.id === pageId,
          })),
      });
    }
  }
  return posts.length;
}

export function replyFacebook(commentId, message, options = {}) {
  return graphRequest(`${encodeURIComponent(commentId)}/comments`, {
    method: 'POST',
    params: { message: String(message).trim() },
    token: options.token || token(),
    fetchImpl: options.fetchImpl,
  });
}

// Уподобання коментаря від імені Сторінки. Той самий дозвіл, що й на
// відповіді (pages_manage_engagement), окремий ендпоінт. Instagram такого не
// вміє через API, тож там лишається тільки відповідь.
export function likeFacebook(commentId, options = {}) {
  return graphRequest(`${encodeURIComponent(commentId)}/likes`, {
    method: 'POST',
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
  like: likeFacebook,
  link: (c) => `https://www.facebook.com/${c.postId}`,
};

// --- Instagram ---------------------------------------------------------------

export function instagramEnabled() {
  return Boolean(process.env.META_IG_USER_ID && process.env.META_PAGE_ACCESS_TOKEN);
}

// Коментарі під дописами Instagram — і верхнього рівня, і в гілках.
//
// Гілка дає РІВНО ОДНОГО кандидата: останню чужу репліку, а вся розмова їде
// поруч контекстом. Логіка та сама, що у Facebook, бо й обмеження ті самі:
// два рівні вкладеності, відповідь публікується на верхній коментар.
export async function fetchInstagramComments(options = {}) {
  const igUserId = process.env.META_IG_USER_ID;
  const data = await graphRequest(`${encodeURIComponent(igUserId)}/media`, {
    params: {
      // caption потрібен, щоб знайти ролик за текстом, коли ID допису на файлі
      // ще не записано; replies — щоб бачити розмову, а не окремі репліки.
      fields: 'id,caption,permalink,comments.limit(25)'
        + '{id,text,timestamp,username,from,replies.limit(25){id,text,timestamp,username,from}}',
      ...(options.after ? { after: options.after } : {}),
      limit: options.limit || LIMIT,
    },
    token: options.token || token(),
    fetchImpl: options.fetchImpl,
  });

  await expandThreads(data.data || [], 'replies', options);
  options.onPage?.({ count: (data.data || []).length, next: data.paging?.next ? data.paging?.cursors?.after || null : null });

  const own = String(process.env.META_IG_USERNAME || '').toLowerCase();
  // Instagram не завжди віддає from, тож звіряємо ще й за іменем автора.
  const isOurs = (c) => c?.from?.id === igUserId
    || (own && String(c?.username || '').toLowerCase() === own);
  const nameOf = (c) => c?.username || 'глядач';
  const byTime = (a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || ''));

  const out = [];
  for (const media of data.data || []) {
    const common = {
      mediaId: media.id || '',
      postText: media.caption || '',
      permalink: media.permalink || '',
    };
    for (const c of media.comments?.data || []) {
      if (!c.id || !c.text || isOurs(c)) continue;

      const replies = [...(c.replies?.data || [])].sort(byTime);
      const snapshot = { ...common, id: c.id, text: c.text, author: nameOf(c), publishedAt: c.timestamp || '',
        thread: replies.map(r => ({ id: r.id, author: isOurs(r) ? 'Канал' : nameOf(r), text: r.text || '', ours: isOurs(r), publishedAt: r.timestamp || '' })) };
      options.onThread?.(snapshot);
      const ours = replies.filter(isOurs);
      const answered = ours.length > 0;
      const lastOursAt = answered ? String(ours[ours.length - 1].timestamp || '') : '';

      if (!answered) {
        out.push({
          ...common,
          id: c.id,
          text: c.text,
          author: nameOf(c),
          publishedAt: c.timestamp || '',
          thread: snapshot.thread,
        });
      }

      const foreign = replies.filter((r) => r.id && r.text && !isOurs(r));
      const after = answered
        ? foreign.filter((r) => String(r.timestamp || '') > lastOursAt)
        : foreign;
      const last = after[after.length - 1];
      if (!last) continue;

      out.push({
        ...common,
        id: last.id,
        text: last.text,
        author: nameOf(last),
        publishedAt: last.timestamp || '',
        parentId: c.id,
        // Рівнів два: відповідь іде на верхній коментар гілки, а до потрібної
        // людини звертаємось на ім'я в самому тексті.
        replyTo: c.id,
        parentAuthor: nameOf(c),
        parentText: c.text,
        threadAnswered: answered,
        thread: replies.filter((r) => r.text).map((r) => ({
          id: r.id, publishedAt: r.timestamp || '',
          author: isOurs(r) ? 'Канал' : nameOf(r),
          text: r.text,
          ours: isOurs(r),
        })),
      });
    }
  }
  if (options.deep && !options.history && data.paging?.next && data.paging?.cursors?.after
      && (options.scanned || 0) + (data.data || []).length < (Number(process.env.META_COMMENTS_DEEP_MAX) || 200)) {
    out.push(...await fetchInstagramComments({ ...options, after: data.paging.cursors.after, scanned: (options.scanned || 0) + (data.data || []).length }));
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

async function historyPage(fetchFn, options) {
  const threads = [];
  let page = { count: 0, next: null };
  await fetchFn({ ...options, history: true, deep: false, limit: 5,
    onThread: c => threads.push(c), onPage: p => { page = p; } });
  return { ...page, threads };
}
facebookAdapter.history = options => historyPage(fetchFacebookComments, options);
instagramAdapter.history = options => historyPage(fetchInstagramComments, options);
