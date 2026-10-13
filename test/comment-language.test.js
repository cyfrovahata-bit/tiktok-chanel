import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseUkrainianThanks } from '../src/comment-thanks.js';
import { checkPlatform } from '../src/comment-flow.js';

test('foreign text with a sticker cannot select a Ukrainian template; Ukrainian mentions and bare reactions can', () => {
  for (const text of ['Thank you!', 'Dziękuję!', 'Grazie!', 'Merci!', 'ありがとう']) assert.equal(canUseUkrainianThanks({ text, sticker: true }), false);
  for (const text of ['Дякую!', 'Спасибо!', '@chy_znaly_vy Дякую!', '❤️']) assert.equal(canUseUkrainianThanks({ text }), true);
});
test('foreign sticker comments use the language-aware model and publish its answer; Ukrainian thanks stay local', async () => {
  const cases = [['Thank you!', 'Thank you for watching!'], ['Dziękuję!', 'Dziękujemy za komentarz!'], ['Grazie!', 'Grazie per il commento!']];
  for (const [text, answer] of cases) {
    const sent = []; let calls = 0;
    await checkPlatform({ key: 'ig', label: 'Instagram', fetch: async () => [{ id: 'c', text, sticker: true }],
      reply: async (_, value) => { sent.push(value); return { id: 'r' }; }, link: () => '' }, {
      state: { seen: {}, drafts: {} }, autoReply: true, postIndex: [], chatId: 'owner', notifyFn: async () => {},
      chat: async prompt => { calls++; assert.match(prompt, /На український або російський коментар відповідай УКРАЇНСЬКОЮ/); return answer; },
    });
    assert.equal(calls, 1); assert.deepEqual(sent, [answer]);
  }
  let calls = 0; let sent;
  await checkPlatform({ key: 'fb', label: 'Facebook', fetch: async () => [{ id: 'c', text: 'Дякую!' }],
    reply: async (_, value) => { sent = value; return { id: 'r' }; }, link: () => '' }, {
    state: { seen: {}, drafts: {} }, autoReply: true, postIndex: [], chatId: 'owner', notifyFn: async () => {},
    chat: async () => { calls++; return ''; },
  });
  assert.equal(calls, 0); assert.match(sent, /[Дд]якуємо|[Рр]аді|[Пп]риємно/);
});
