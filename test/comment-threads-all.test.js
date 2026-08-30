// Гілки на YouTube та в Instagram. Facebook це вміє давно, і саме там видно,
// чого варта помилка: на одну розмову прилітало по три картки, а канал
// відповідав тричі там, де досить раз. Тому обидва нові фетчери перевіряємо
// на тих самих випадках, що й Facebook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchComments } from '../src/yt-comments.js';
import { fetchInstagramComments } from '../src/meta-comments.js';

const MINE = 'UCканал';

// --- YouTube -----------------------------------------------------------------

function ytComment({ id, text, who, at, mine = false }) {
  return {
    id,
    snippet: {
      textOriginal: text,
      authorDisplayName: who,
      authorChannelId: { value: mine ? MINE : `UC${who}` },
      publishedAt: at,
    },
  };
}

function ytClient(threads) {
  return {
    commentThreads: { list: async () => ({ data: { items: threads } }) },
    comments: { list: async () => ({ data: { items: [] } }) },
  };
}

function ytThread({ videoId = 'vid1', top, replies = [] }) {
  return {
    snippet: { videoId, topLevelComment: top, totalReplyCount: replies.length },
    replies: replies.length ? { comments: replies } : undefined,
  };
}

test('YouTube: коментар без відповідей іде як звичайний', async () => {
  const top = ytComment({ id: 'c1', text: 'Цікаво', who: 'Оля', at: '2026-08-30T10:00:00Z' });
  const out = await fetchComments({ client: ytClient([ytThread({ top })]), channelId: MINE });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'c1');
  assert.equal(out[0].parentId, undefined);
  assert.equal(out[0].videoId, 'vid1');
});

test('YouTube: гілка дає одного кандидата — останню чужу репліку', async () => {
  const top = ytComment({ id: 'c1', text: 'А в Хотині інакше', who: 'Оля', at: '2026-08-30T10:00:00Z' });
  const replies = [
    ytComment({ id: 'r1', text: 'Ні, так', who: 'Петро', at: '2026-08-30T11:00:00Z' }),
    ytComment({ id: 'r2', text: 'А джерело?', who: 'Оля', at: '2026-08-30T12:00:00Z' }),
  ];
  const out = await fetchComments({ client: ytClient([ytThread({ top, replies })]), channelId: MINE });
  // Верхній коментар — окремо, і рівно один кандидат із гілки.
  assert.equal(out.length, 2);
  const thread = out.find((c) => c.parentId);
  assert.equal(thread.id, 'r2');
  assert.equal(thread.replyTo, 'c1', 'відповідати треба на верхній коментар');
  assert.equal(thread.parentAuthor, 'Оля');
  assert.equal(thread.threadAnswered, false);
  assert.equal(thread.thread.length, 2, 'уся розмова їде контекстом');
});

test('YouTube: де канал уже відповів, беремо лише нове після нашої репліки', async () => {
  const top = ytComment({ id: 'c1', text: 'Питання', who: 'Оля', at: '2026-08-30T10:00:00Z' });
  const replies = [
    ytComment({ id: 'r1', text: 'Стара репліка', who: 'Петро', at: '2026-08-30T10:30:00Z' }),
    ytComment({ id: 'r2', text: 'Відповідь каналу', who: 'Канал', at: '2026-08-30T11:00:00Z', mine: true }),
    ytComment({ id: 'r3', text: 'А ще питання', who: 'Оля', at: '2026-08-30T12:00:00Z' }),
  ];
  const out = await fetchComments({ client: ytClient([ytThread({ top, replies })]), channelId: MINE });
  assert.equal(out.length, 1, 'верхній коментар уже закритий нашою відповіддю');
  assert.equal(out[0].id, 'r3');
  assert.equal(out[0].threadAnswered, true);
  assert.equal(out[0].thread.some((r) => r.ours), true);
});

test('YouTube: після нашої відповіді без нових реплік не пропонуємо нічого', async () => {
  const top = ytComment({ id: 'c1', text: 'Дякую', who: 'Оля', at: '2026-08-30T10:00:00Z' });
  const replies = [ytComment({ id: 'r1', text: 'І вам', who: 'Канал', at: '2026-08-30T11:00:00Z', mine: true })];
  const out = await fetchComments({ client: ytClient([ytThread({ top, replies })]), channelId: MINE });
  assert.deepEqual(out, []);
});

test('YouTube: власні коментарі каналу не стають кандидатами', async () => {
  const top = ytComment({ id: 'c1', text: 'Наш закріп', who: 'Канал', at: '2026-08-30T10:00:00Z', mine: true });
  const out = await fetchComments({ client: ytClient([ytThread({ top })]), channelId: MINE });
  assert.deepEqual(out, []);
});

test('YouTube: довгу гілку догортаємо окремим викликом', async () => {
  const top = ytComment({ id: 'c1', text: 'Розмова', who: 'Оля', at: '2026-08-30T10:00:00Z' });
  const inline = [ytComment({ id: 'r1', text: 'перша', who: 'Петро', at: '2026-08-30T10:10:00Z' })];
  const full = [
    ...inline,
    ytComment({ id: 'r9', text: 'остання', who: 'Ірина', at: '2026-08-30T13:00:00Z' }),
  ];
  const client = {
    commentThreads: {
      list: async () => ({
        data: {
          items: [{
            snippet: { videoId: 'vid1', topLevelComment: top, totalReplyCount: 9 },
            replies: { comments: inline },
          }],
        },
      }),
    },
    comments: { list: async () => ({ data: { items: full } }) },
  };
  const out = await fetchComments({ client, channelId: MINE });
  const thread = out.find((c) => c.parentId);
  assert.equal(thread.id, 'r9', 'узяли останню репліку з догорнутої гілки');
});

// --- Instagram ---------------------------------------------------------------

function igMedia(comments) {
  return {
    data: [{
      id: 'm1',
      caption: 'Опис допису',
      permalink: 'https://instagram.com/p/x',
      comments: { data: comments },
    }],
  };
}

function igRun(comments) {
  process.env.META_IG_USER_ID = 'ig-me';
  process.env.META_PAGE_ACCESS_TOKEN = 'token';
  process.env.META_IG_USERNAME = 'chyvyznaly';
  return fetchInstagramComments({ fetchImpl: async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(igMedia(comments)),
  }) });
}

test('Instagram: коментар без відповідей іде як звичайний, з описом допису', async () => {
  const out = await igRun([
    { id: 'c1', text: 'Клас', username: 'olya', timestamp: '2026-08-30T10:00:00+0000' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'c1');
  assert.equal(out[0].mediaId, 'm1');
  assert.equal(out[0].postText, 'Опис допису');
});

test('Instagram: гілка дає одного кандидата й відповідь на верхній коментар', async () => {
  const out = await igRun([{
    id: 'c1',
    text: 'А де це?',
    username: 'olya',
    timestamp: '2026-08-30T10:00:00+0000',
    replies: {
      data: [
        { id: 'r1', text: 'У Мукачеві', username: 'petro', timestamp: '2026-08-30T11:00:00+0000' },
        { id: 'r2', text: 'Точно?', username: 'olya', timestamp: '2026-08-30T12:00:00+0000' },
      ],
    },
  }]);
  assert.equal(out.length, 2);
  const thread = out.find((c) => c.parentId);
  assert.equal(thread.id, 'r2');
  assert.equal(thread.replyTo, 'c1');
  assert.equal(thread.thread.length, 2);
});

test('Instagram: свою відповідь бачимо і за from, і за іменем', async () => {
  const out = await igRun([{
    id: 'c1',
    text: 'Питання',
    username: 'olya',
    timestamp: '2026-08-30T10:00:00+0000',
    replies: {
      data: [
        { id: 'r1', text: 'Відповідь', username: 'chyvyznaly', timestamp: '2026-08-30T11:00:00+0000' },
        { id: 'r2', text: 'Ще одне', username: 'olya', timestamp: '2026-08-30T12:00:00+0000' },
      ],
    },
  }]);
  assert.equal(out.length, 1, 'верхній коментар уже закритий');
  assert.equal(out[0].id, 'r2');
  assert.equal(out[0].threadAnswered, true);
});

test('Instagram: після нашої відповіді без нових реплік мовчимо', async () => {
  const out = await igRun([{
    id: 'c1',
    text: 'Дякую',
    username: 'olya',
    timestamp: '2026-08-30T10:00:00+0000',
    replies: { data: [{ id: 'r1', text: 'І вам', from: { id: 'ig-me' }, timestamp: '2026-08-30T11:00:00+0000' }] },
  }]);
  assert.deepEqual(out, []);
});
