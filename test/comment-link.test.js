// Зв'язок «коментар → ролик» для Facebook. Там ID допису на файл ніхто не
// записує (публікується вручну), тож ролик шукається за текстом допису.
// Хибна прив'язка тут гірша за її відсутність: вона тиха, довічна й отруює
// всі майбутні відповіді під цим дописом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPostByText, findPost, normalizeForMatch, draftPrompt } from '../src/comment-flow.js';

const INDEX = [
  {
    fileId: 'f1',
    props: {},
    item: {
      id: 'A1',
      title: 'Одеські катакомби: як будівництво міста створило підземний лабіринт',
      theme: 'Як будівництво Одеси створило лабіринт катакомб',
      extra: '',
    },
  },
  {
    fileId: 'f2',
    props: {},
    item: {
      id: 'A2',
      title: 'Хотинська фортеця: замок, який ти бачив у десятках фільмів',
      theme: 'Хотинська фортеця в кіно',
      extra: '',
    },
  },
];

test('назва з допису знаходить рядок дослівно', () => {
  const post = 'Одеські катакомби: як будівництво міста створило підземний лабіринт\n\n'
    + 'Під Одесою тягнеться дві тисячі кілометрів ходів. #Україна';
  const hit = matchPostByText(INDEX, post);
  assert.equal(hit.entry.item.id, 'A1');
  assert.equal(hit.strength, 'strong');
});

test('трохи змінений текст ловиться слабким збігом', () => {
  const post = 'Хотинська фортеця — той самий замок, що ви бачили у десятках фільмів!';
  const hit = matchPostByText(INDEX, post);
  assert.equal(hit.entry.item.id, 'A2');
  assert.equal(hit.strength, 'weak');
});

test('чужий текст не прив\'язується ні до чого', () => {
  assert.equal(matchPostByText(INDEX, 'Доброго ранку, друзі! Гарного дня всім'), null);
  assert.equal(matchPostByText(INDEX, ''), null);
  assert.equal(matchPostByText([], 'будь-що'), null);
});

test('дві однаково схожі назви — краще нічого, ніж навмання', () => {
  const twins = [
    { fileId: 'f1', props: {}, item: { id: 'A', title: 'Замок над Дністром узимку', extra: '' } },
    { fileId: 'f2', props: {}, item: { id: 'Б', title: 'Замок над Дністром улітку', extra: '' } },
  ];
  assert.equal(matchPostByText(twins, 'Замок над Дністром'), null);
});

test('нормалізація прибирає розділові знаки й регістр', () => {
  assert.equal(normalizeForMatch('«Кобзар», 0,6 мм²: — тест!'), 'кобзар 0 6 мм² тест'.replace('²', '²'));
});

test('знайдений за дослівним збігом ролик закріплюється на файлі', () => {
  const comment = { id: 'c1', postId: '123_456', postText: INDEX[0].item.title };
  const post = findPost(INDEX, 'fb', comment);
  assert.equal(post.matchedBy, 'strong');
  assert.deepEqual(post.bind, { fileId: 'f1', prop: 'facebookPostId', postId: '123_456' });
});

test('слабкий збіг дає контекст, але на файлі не закріплюється', () => {
  const comment = { id: 'c2', postId: '123_789', postText: 'Хотинська фортеця — замок із десятків фільмів' };
  const post = findPost(INDEX, 'fb', comment);
  assert.equal(post.matchedBy, 'weak');
  assert.equal(post.bind, null);
});

test('записаний ID має пріоритет над текстом', () => {
  const index = [{ ...INDEX[0], props: { facebookPostId: '123_456' } }, INDEX[1]];
  const comment = { id: 'c3', postId: '123_456', postText: INDEX[1].item.title };
  assert.equal(findPost(index, 'fb', comment).matchedBy, 'id');
});

test('коли ролик невідомий — промт це прямо каже', () => {
  const prompt = draftPrompt({ author: 'Іван', text: 'дякую' }, 'Facebook', null);
  assert.match(prompt, /РОЛИК НЕВІДОМИЙ/);
  assert.match(prompt, /НЕ вигадуй/);
});

test('коли ролик відомий — у промті його текст, а не попередження', () => {
  const prompt = draftPrompt({ author: 'Іван', text: 'дякую' }, 'Facebook', {
    title: 'Одеські катакомби', theme: '', script: ['ПІД ОДЕСОЮ ДВІ ТИСЯЧІ КІЛОМЕТРІВ ХОДІВ'],
  });
  assert.match(prompt, /ПРО ЩО БУВ РОЛИК/);
  assert.match(prompt, /ДВІ ТИСЯЧІ КІЛОМЕТРІВ/);
  assert.doesNotMatch(prompt, /РОЛИК НЕВІДОМИЙ/);
});
