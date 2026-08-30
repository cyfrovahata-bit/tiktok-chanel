// Відповіді у гілках під чужими коментарями. Найтонше місце — не написати в
// одну гілку двічі й не влізти в чужу сварку; за це відповідають вибірка
// (одна кандидатура на гілку) і правила в промті.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFacebookComments } from '../src/meta-comments.js';
import { draftPrompt } from '../src/comment-flow.js';

process.env.META_PAGE_ID = 'PAGE1';
process.env.META_PAGE_ACCESS_TOKEN = 'token';

const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

function pageWith(comments) {
  return async () => reply({ data: [{ id: 'POST1', message: 'Одеські катакомби', comments: { data: comments } }] });
}

test('гілка дає ОДНУ кандидатуру — останню чужу репліку', async () => {
  const list = await fetchFacebookComments({
    fetchImpl: pageWith([{
      id: 'CM1',
      message: 'А хіба вони не давніші?',
      from: { id: 'U1', name: 'Оксана' },
      comments: {
        data: [
          { id: 'R1', message: 'Ні, копали під забудову', from: { id: 'U2', name: 'Петро' }, created_time: '2026-08-01T10:00:00+0000' },
          { id: 'R2', message: 'А звідки це відомо?', from: { id: 'U1', name: 'Оксана' }, created_time: '2026-08-01T11:00:00+0000' },
        ],
      },
    }]),
  });

  // Верхній коментар плюс рівно одна кандидатура з гілки.
  assert.deepEqual(list.map((c) => c.id), ['CM1', 'R2']);
  const inThread = list[1];
  assert.equal(inThread.parentId, 'CM1');
  assert.equal(inThread.parentAuthor, 'Оксана');
  assert.equal(inThread.thread.length, 2, 'уся розмова їде контекстом');
  assert.equal(inThread.threadAnswered, false);
});

test('де ми вже відповіли — беремо лише те, що написали ПІСЛЯ нас', async () => {
  const list = await fetchFacebookComments({
    fetchImpl: pageWith([{
      id: 'CM2',
      message: 'Цікаво',
      from: { id: 'U1', name: 'Оксана' },
      comments: {
        data: [
          { id: 'R1', message: 'Було не так', from: { id: 'U2', name: 'Петро' }, created_time: '2026-08-01T10:00:00+0000' },
          { id: 'R2', message: 'Дякуємо, уточнимо', from: { id: 'PAGE1' }, created_time: '2026-08-01T11:00:00+0000' },
          { id: 'R3', message: 'А звідки ви взяли цю дату?', from: { id: 'U2', name: 'Петро' }, created_time: '2026-08-01T12:00:00+0000' },
        ],
      },
    }]),
  });

  const ids = list.map((c) => c.id);
  assert.ok(!ids.includes('CM2'), 'у гілці вже писали — верхній коментар не пропонуємо');
  assert.ok(!ids.includes('R1'), 'до нашої відповіді не повертаємось');
  assert.deepEqual(ids, ['R3']);
  assert.equal(list[0].threadAnswered, true);
});

test('гілка, де після нас нічого нового, не турбує зайвий раз', async () => {
  const list = await fetchFacebookComments({
    fetchImpl: pageWith([{
      id: 'CM3',
      message: 'Клас',
      from: { id: 'U1', name: 'Оксана' },
      comments: {
        data: [
          { id: 'R1', message: 'Так', from: { id: 'U2', name: 'Петро' }, created_time: '2026-08-01T10:00:00+0000' },
          { id: 'R2', message: 'Дякуємо!', from: { id: 'PAGE1' }, created_time: '2026-08-01T11:00:00+0000' },
        ],
      },
    }]),
  });
  assert.deepEqual(list, []);
});

test('свої ж репліки в гілці за кандидатуру не беремо', async () => {
  const list = await fetchFacebookComments({
    fetchImpl: pageWith([{
      id: 'CM4',
      message: 'Питання',
      from: { id: 'U1', name: 'Оксана' },
      comments: { data: [{ id: 'R1', message: 'Наша відповідь', from: { id: 'PAGE1' }, created_time: '2026-08-01T10:00:00+0000' }] },
    }]),
  });
  assert.deepEqual(list, []);
});

// --- Правила в промті --------------------------------------------------------

const THREAD_COMMENT = {
  author: 'Петро',
  text: 'Насправді копали під забудову',
  parentId: 'CM1',
  parentAuthor: 'Оксана',
  parentText: 'А хіба вони не давніші?',
  thread: [
    { author: 'Петро', text: 'Насправді копали під забудову', ours: false },
  ],
};

test('у гілці промт дозволяє закрити суперечку про факт і відгукнутись на досвід', () => {
  const p = draftPrompt(THREAD_COMMENT, 'Facebook', null);
  assert.match(p, /ЦЕ ВІДПОВІДЬ У ГІЛЦІ/);
  assert.match(p, /СПЕРЕЧАЮТЬСЯ ПРО ФАКТ/);
  assert.match(p, /ділиться своїм/);
  assert.match(p, /на хвилину все не вміщається/);
});

test('у гілці заборонена особиста сварка й закид про канал', () => {
  const p = draftPrompt(THREAD_COMMENT, 'Facebook', null);
  assert.match(p, /ОСОБИСТА СВАРКА/);
  assert.match(p, /на нього відповідає власник/);
});

test('уся розмова гілки їде в промт', () => {
  const p = draftPrompt(THREAD_COMMENT, 'Facebook', null);
  assert.match(p, /Гілка, верхній коментар — Оксана/);
  assert.match(p, /А хіба вони не давніші\?/);
  assert.match(p, /саме на нього відповідаємо/);
});

test('там, де ми вже писали, промт вимагає прямого звертання до каналу', () => {
  const p = draftPrompt({ ...THREAD_COMMENT, threadAnswered: true }, 'Facebook', null);
  assert.match(p, /у цій гілці ми ВЖЕ відповідали/);
  assert.match(p, /саме до каналу/);
});

test('у звичайному коментарі правил гілки немає', () => {
  const p = draftPrompt({ author: 'Іван', text: 'дякую' }, 'Facebook', null);
  assert.doesNotMatch(p, /ЦЕ ВІДПОВІДЬ У ГІЛЦІ/);
});
