import test from 'node:test';
import assert from 'node:assert/strict';
import { isSticker } from '../src/meta-comments.js';
import { isReaction, thanksReply, EMOJI_THANKS } from '../src/comment-thanks.js';

test('коментар зі стікером і без тексту — це реакція', () => {
  assert.equal(isSticker({ message: '', attachment: { type: 'sticker' } }), true);
  assert.equal(isSticker({ attachment: { url: 'https://scontent/gif' } }), true);
});

test('текст поруч зі стікером робить коментар звичайним', () => {
  // Написали слова та ще й приклали картинку — це вже думка, її читає власник.
  assert.equal(isSticker({ message: 'Так', attachment: { type: 'sticker' } }), false);
});

test('порожній коментар без вкладення реакцією не вважається', () => {
  assert.equal(isSticker({ message: '' }), false);
  assert.equal(isSticker({ message: '', attachment: {} }), false);
});

test('реакція — це і стікер, і сама емодзі', () => {
  assert.equal(isReaction({ sticker: true, text: '' }), true);
  assert.equal(isReaction({ text: '❤️❤️' }), true);
  assert.equal(isReaction({ text: 'Вчила в школі.' }), false);
});

test('на стікер відповідаємо подякою за реакцію, а не за думку', () => {
  const text = thanksReply({ id: 'fb_1', sticker: true, text: '' });
  assert.ok(EMOJI_THANKS.some((opener) => text.startsWith(opener)), text);
  assert.match(text, /!$/);
});

test('під одним дописом дві реакції не дістають однакову відповідь', () => {
  const first = thanksReply({ id: 'fb_1', sticker: true, text: '' });
  const second = thanksReply({ id: 'fb_2', sticker: true, text: '' }, { recent: [first] });
  assert.notEqual(first, second);
});

test('та сама реакція завжди дає ту саму відповідь', () => {
  // Повторний прохід після збою не має лишити під дописом два різні тексти.
  const a = thanksReply({ id: 'fb_9', sticker: true, text: '' });
  const b = thanksReply({ id: 'fb_9', sticker: true, text: '' });
  assert.equal(a, b);
});
