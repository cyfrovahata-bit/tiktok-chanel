import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchComments, draftReply, draftPrompt } from '../src/yt-comments.js';

const MINE = 'UC-channel-mine';

function thread(id, text, authorChannelId, author = 'Глядач', replies = []) {
  return {
    replies: replies.length ? { comments: replies } : undefined,
    snippet: {
      videoId: 'vid1',
      topLevelComment: {
        id,
        snippet: {
          textOriginal: text,
          authorDisplayName: author,
          authorChannelId: { value: authorChannelId },
          publishedAt: '2026-07-28T10:00:00Z',
        },
      },
    },
  };
}

function fakeClient(items) {
  return { commentThreads: { list: async () => ({ data: { items } }) } };
}

test('коментарі: власні відповіді каналу не потрапляють у список', async () => {
  const client = fakeClient([
    thread('c1', 'Цікаво!', 'UC-viewer'),
    thread('c2', 'Дякуємо!', MINE), // наша ж відповідь
  ]);
  const list = await fetchComments({ client, channelId: MINE });
  assert.deepEqual(list.map((c) => c.id), ['c1']);
  assert.equal(list[0].text, 'Цікаво!');
  assert.equal(list[0].videoId, 'vid1');
});

test('коментарі: без id не беремо', async () => {
  const broken = thread(undefined, 'текст', 'UC-viewer');
  const list = await fetchComments({ client: fakeClient([broken]), channelId: MINE });
  assert.deepEqual(list, []);
});

test('чернетка: слово ПРОПУСТИТИ означає «не відповідати»', async () => {
  const draft = await draftReply(
    { author: 'Тролль', text: 'дурня якась' },
    { chat: async () => 'ПРОПУСТИТИ' },
  );
  assert.equal(draft, null);
});

test('чернетка: лапки навколо відповіді прибираються', async () => {
  const draft = await draftReply(
    { author: 'Глядач', text: 'А де це?' },
    { chat: async () => '«У Соледарі, на глибині 288 метрів.»' },
  );
  assert.equal(draft, 'У Соледарі, на глибині 288 метрів.');
});

test('чернетка: порожня відповідь моделі — теж пропуск', async () => {
  assert.equal(await draftReply({ author: 'x', text: 'y' }, { chat: async () => '   ' }), null);
});

test('промт містить текст коментаря і правило пропуску', () => {
  const prompt = draftPrompt({ author: 'Оля', text: 'А скільки це коштує?' });
  assert.match(prompt, /А скільки це коштує\?/);
  assert.match(prompt, /Оля/);
  assert.match(prompt, /ПРОПУСТИТИ/);
  assert.match(prompt, /до 200 символів/);
});

test('коментарі: гілку, де ми вже відповідали, більше не пропонуємо', async () => {
  const answered = thread('c3', 'А де це?', 'UC-viewer', 'Оля', [
    { snippet: { authorChannelId: { value: MINE }, textOriginal: 'У Соледарі' } },
  ]);
  const byOther = thread('c4', 'Клас', 'UC-viewer', 'Петро', [
    { snippet: { authorChannelId: { value: 'UC-someone' }, textOriginal: 'ага' } },
  ]);
  const list = await fetchComments({ client: fakeClient([answered, byOther]), channelId: MINE });
  assert.deepEqual(list.map((c) => c.id), ['c4'], 'чужа відповідь у гілці не рахується за нашу');
});
