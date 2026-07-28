import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchFacebookComments, replyFacebook,
  fetchInstagramComments, replyInstagram,
} from '../src/meta-comments.js';

process.env.META_PAGE_ID = 'PAGE1';
process.env.META_PAGE_ACCESS_TOKEN = 'token';
process.env.META_IG_USER_ID = 'IG1';
process.env.META_IG_USERNAME = 'chy_znaly_vy';

function reply(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

test('Facebook: свої ж коментарі під дописом не потрапляють у список', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return reply({
      data: [{
        id: 'POST1',
        comments: {
          data: [
            { id: 'CM1', message: 'Класно!', from: { id: 'USER9', name: 'Оля' } },
            { id: 'CM2', message: 'Дякуємо!', from: { id: 'PAGE1', name: 'Чи Знали Ви?' } },
            { id: 'CM3', from: { id: 'USER8', name: 'Без тексту' } }, // стікер без message
          ],
        },
      }],
    });
  };

  const list = await fetchFacebookComments({ fetchImpl });
  assert.deepEqual(list.map((c) => c.id), ['CM1']);
  assert.equal(list[0].author, 'Оля');
  assert.equal(list[0].postId, 'POST1');
  assert.match(calls[0], /PAGE1\/posts/);
});

test('Facebook: відповідь іде на ребро comments потрібного коментаря', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: String(options?.body ?? '') });
    return reply({ id: 'CM1_reply' });
  };
  await replyFacebook('CM1', '  Дякуємо!  ', { fetchImpl });
  assert.match(calls[0].url, /CM1\/comments/);
  assert.match(calls[0].body, /message=%D0%94/); // «Дякуємо!» у percent-encoding
  assert.ok(!calls[0].body.includes('+++'), 'зайві пробіли обрізано');
});

test('Instagram: власні коментарі відсіюються за іменем акаунта', async () => {
  const fetchImpl = async () => reply({
    data: [{
      id: 'MEDIA1',
      permalink: 'https://instagram.com/p/abc',
      comments: {
        data: [
          { id: 'IC1', text: 'А де це?', username: 'petro' },
          { id: 'IC2', text: 'Це Соледар', username: 'chy_znaly_vy' },
        ],
      },
    }],
  });

  const list = await fetchInstagramComments({ fetchImpl });
  assert.deepEqual(list.map((c) => c.id), ['IC1']);
  assert.equal(list[0].author, 'petro');
  assert.equal(list[0].permalink, 'https://instagram.com/p/abc');
});

test('Instagram: відповідь іде на ребро replies', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return reply({ id: 'IC1_reply' }); };
  await replyInstagram('IC1', 'Це Соледар', { fetchImpl });
  assert.match(calls[0], /IC1\/replies/);
});

test('Facebook: коментар, під яким Сторінка вже відповіла, не пропонується', async () => {
  const fetchImpl = async () => reply({
    data: [{
      id: 'POST1',
      comments: {
        data: [
          {
            id: 'CM1', message: 'А де це?', from: { id: 'USER9', name: 'Оля' },
            comments: { data: [{ from: { id: 'PAGE1' } }] }, // наша відповідь
          },
          {
            id: 'CM2', message: 'Клас', from: { id: 'USER8', name: 'Петро' },
            comments: { data: [{ from: { id: 'USER7' } }] }, // відповів інший глядач
          },
        ],
      },
    }],
  });
  const list = await fetchFacebookComments({ fetchImpl });
  assert.deepEqual(list.map((c) => c.id), ['CM2'], 'чужа відповідь за нашу не рахується');
});

test('Instagram: гілка з нашою відповіддю не пропонується', async () => {
  const fetchImpl = async () => reply({
    data: [{
      id: 'MEDIA1',
      comments: {
        data: [
          { id: 'IC1', text: 'А де це?', username: 'petro', replies: { data: [{ username: 'chy_znaly_vy' }] } },
          { id: 'IC2', text: 'Гарно', username: 'olha', replies: { data: [{ username: 'hto_s' }] } },
        ],
      },
    }],
  });
  const list = await fetchInstagramComments({ fetchImpl });
  assert.deepEqual(list.map((c) => c.id), ['IC2']);
});
