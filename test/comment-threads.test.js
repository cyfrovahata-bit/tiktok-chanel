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

// --- Куди саме йде відповідь -------------------------------------------------
// Facebook приймає відповідь ЛИШЕ на верхній коментар. POST на ID вкладеної
// репліки повертає «Unsupported post request» — на цьому й спіткнулась перша
// спроба відповісти в гілці.
import { registerPlatform, handleCallback } from '../src/comment-flow.js';

test('вкладена репліка несе ID верхнього коментаря', async () => {
  const list = await fetchFacebookComments({
    fetchImpl: pageWith([{
      id: 'CM_TOP',
      message: 'А хто його будував?',
      from: { id: 'U1', name: 'Оксана' },
      comments: {
        data: [{ id: 'CM_REPLY', message: 'Турки', from: { id: 'U2', name: 'Петро' }, created_time: '2026-08-01T10:00:00+0000' }],
      },
    }]),
  });
  const inThread = list.find((c) => c.parentId);
  assert.equal(inThread.id, 'CM_REPLY', 'відповідаємо саме на цю репліку за змістом');
  assert.equal(inThread.replyTo, 'CM_TOP', 'а публікуємо у верхній коментар');
});

test('надсилання з Telegram шле у верхній коментар, а не у вкладену репліку', async () => {
  const sent = [];
  registerPlatform({
    key: 'fbtest',
    label: 'FB',
    icon: '💬',
    enabled: () => true,
    fetch: async () => [],
    reply: async (id, text) => { sent.push({ id, text }); },
    link: () => '',
  });

  process.env.TELEGRAM_CHAT_ID = '77';
  const state = {
    seen: {},
    drafts: { 'fbtest:CM_REPLY': { text: 'Петре, дякуємо!', messageId: 5, replyTo: 'CM_TOP' } },
  };
  // Далі за публікацією йдуть Drive і Telegram, яких у тесті немає — їхнє
  // падіння нас не цікавить, важливо КУДИ пішла відповідь.
  await handleCallback(
    { id: 'q1', data: 'c:s:fbtest:CM_REPLY', from: { id: 77 }, message: { message_id: 5 } },
    { state },
  ).catch(() => {});

  assert.deepEqual(sent, [{ id: 'CM_TOP', text: 'Петре, дякуємо!' }]);
});

// --- Зрозумілі помилки -------------------------------------------------------
import { humanError } from '../src/comment-flow.js';

test('зникнення коментаря пояснюється по-людськи', () => {
  // Саме це побачив власник: «Unsupported post request. Object with ID…».
  assert.equal(
    humanError("Unsupported post request. Object with ID '122109' does not exist, cannot be loaded due to missing permissions"),
    'коментар уже видалено або сховано (пробував і гілку, і сам коментар)',
  );
});

test('обмеження й доступи теж називаються словами', () => {
  assert.match(humanError('(#4) Application request limit reached'), /обмежив дії Сторінки/);
  assert.match(humanError('Invalid OAuth access token'), /перевір токен/);
});

test('незнайому помилку не ховаємо', () => {
  assert.equal(humanError('щось геть нове'), 'щось геть нове');
});

// --- Два шляхи публікації ----------------------------------------------------
import { sendReply } from '../src/comment-flow.js';

const GONE = "Unsupported post request. Object with ID '1' does not exist";

test('якщо верхній коментар не приймає — пробуємо саму репліку', async () => {
  const tried = [];
  const adapter = {
    reply: async (id) => {
      tried.push(id);
      if (id === 'TOP') throw new Error(GONE);
    },
  };
  const out = await sendReply(adapter, ['TOP', 'REPLY'], 'текст');
  assert.deepEqual(tried, ['TOP', 'REPLY']);
  assert.equal(out.id, 'REPLY');
});

test('перший же успіх зупиняє спроби', async () => {
  const tried = [];
  const adapter = { reply: async (id) => { tried.push(id); } };
  await sendReply(adapter, ['TOP', 'REPLY'], 'текст');
  assert.deepEqual(tried, ['TOP']);
});

test('помилка НЕ про зниклий об\'єкт другого ID не смикає', async () => {
  // Бракує доступу — другий ID тут нічим не зарадить, а зайвий виклик лише
  // наближає обмеження Facebook.
  const tried = [];
  const adapter = {
    reply: async (id) => { tried.push(id); throw new Error('Invalid OAuth access token'); },
  };
  await assert.rejects(() => sendReply(adapter, ['TOP', 'REPLY'], 'текст'));
  assert.deepEqual(tried, ['TOP']);
});

test('однакові ID не пробуються двічі', async () => {
  const tried = [];
  const adapter = { reply: async (id) => { tried.push(id); throw new Error(GONE); } };
  await assert.rejects(() => sendReply(adapter, ['SAME', 'SAME'], 'текст'));
  assert.deepEqual(tried, ['SAME']);
});

// --- Глибокий обхід ----------------------------------------------------------
// Звичайний прохід дивиться десять останніх дописів; раз на добу треба пройти
// всю історію, бо під старими роликами теж пишуть.

test('звичайний прохід бере лише першу сторінку дописів', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return reply({
      data: [{ id: 'P1', message: 'Допис', comments: { data: [] } }],
      paging: { cursors: { after: 'CURSOR2' } },
    });
  };
  await fetchFacebookComments({ fetchImpl });
  assert.equal(calls.length, 1, 'по сторінках не ходимо');
});

test('глибокий обхід іде за курсором далі', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    // Дві сторінки, далі курсора немає.
    if (calls.length === 1) {
      return reply({
        data: [{ id: 'P1', message: 'Перший', comments: { data: [{ id: 'C1', message: 'Дякую', from: { id: 'U1', name: 'Оля' } }] } }],
        paging: { cursors: { after: 'CURSOR2' } },
      });
    }
    return reply({
      data: [{ id: 'P2', message: 'Другий', comments: { data: [{ id: 'C2', message: 'Клас', from: { id: 'U2', name: 'Петро' } }] } }],
    });
  };
  const list = await fetchFacebookComments({ fetchImpl, deep: true });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('after=CURSOR2'), 'друга сторінка береться за курсором');
  assert.deepEqual(list.map((c) => c.id), ['C1', 'C2']);
});

test('глибокий обхід не ходить нескінченно', async () => {
  // Facebook віддає курсор навіть на порожній сторінці — без стелі це був би
  // вічний цикл на кожному нічному проході.
  process.env.META_COMMENTS_DEEP_MAX = '3';
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return reply({
      data: [{ id: `P${calls}`, message: 'Допис', comments: { data: [] } }],
      paging: { cursors: { after: `CURSOR${calls + 1}` } },
    });
  };
  await fetchFacebookComments({ fetchImpl, deep: true });
  assert.ok(calls <= 4, `забагато звернень: ${calls}`);
  delete process.env.META_COMMENTS_DEEP_MAX;
});
