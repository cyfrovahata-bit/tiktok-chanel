import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCallbackData } from '../src/comment-flow.js';

test('мітка кнопки: нинішній формат', () => {
  assert.deepEqual(parseCallbackData('c:s:fb:1217780308083247_98765'), {
    action: 's', platformKey: 'fb', commentId: '1217780308083247_98765',
  });
});

test('мітка кнопки: старий формат картки з часів «лише YouTube»', () => {
  // Такі картки й досі висять у чаті — кнопка мусить працювати, а не мовчати.
  assert.deepEqual(parseCallbackData('ytc:x:UgxKREWxIgDrw8w2e'), {
    action: 'x', platformKey: 'yt', commentId: 'UgxKREWxIgDrw8w2e',
  });
});

test('мітка кнопки: id із двокрапками не втрачається', () => {
  assert.equal(parseCallbackData('c:e:ig:aaa:bbb:ccc').commentId, 'aaa:bbb:ccc');
});

test('мітка кнопки: чужі натискання не наші', () => {
  assert.equal(parseCallbackData('other_theme'), null);
  assert.equal(parseCallbackData(''), null);
  assert.equal(parseCallbackData('c:s'), null);
});

// Картка має приходити на КОЖЕН коментар — навіть той, на який модель радить
// не відповідати. Власник вирішує сам, тому кнопки лишаються.
import { checkPlatform } from '../src/comment-flow.js';

function adapterWith(comments) {
  return {
    key: 'tst', label: 'Тест', icon: '🧪',
    fetch: async () => comments,
    reply: async () => ({}),
    link: () => 'https://example.com/1',
  };
}

test('коментар без чернетки все одно приходить карткою, але без «Надіслати»', async () => {
  const sent = [];
  const state = { seen: {}, drafts: {} };
  const result = await checkPlatform(adapterWith([{ id: 'x1', text: 'дурень', author: 'Тролль' }]), {
    state,
    chat: async () => 'ПРОПУСТИТИ',
    chatId: '1',
    notifyFn: async (_chat, text, markup) => { sent.push({ text, markup }); return { message_id: 55 }; },
  });

  assert.equal(sent.length, 1, 'картка надіслана попри пораду промовчати');
  assert.match(sent[0].text, /Модель радить не відповідати/);
  const labels = sent[0].markup.inline_keyboard[0].map((b) => b.text);
  assert.deepEqual(labels, ['✏️ Змінити', '🚫 Пропустити'], 'кнопки «Надіслати» немає');
  assert.equal(state.seen['tst:x1'], 'pending');
  assert.equal(state.drafts['tst:x1'].text, null);
  assert.equal(result.flagged, 1);
});

test('звичайний коментар отримує всі три кнопки', async () => {
  const sent = [];
  const state = { seen: {}, drafts: {} };
  await checkPlatform(adapterWith([{ id: 'x2', text: 'А де це?', author: 'Оля' }]), {
    state,
    chat: async () => 'У Соледарі.',
    chatId: '1',
    notifyFn: async (_chat, text, markup) => { sent.push({ text, markup }); return { message_id: 56 }; },
  });
  assert.equal(sent[0].markup.inline_keyboard[0].length, 3);
  assert.equal(state.drafts['tst:x2'].text, 'У Соледарі.');
});
