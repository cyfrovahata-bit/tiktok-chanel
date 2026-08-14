// Рядок, який ChatGPT зупинив на перевірці фактів, показується в мінідодатку
// разом із вихідним текстом власника. Той текст ніде більше не зберігається:
// у чаті з ботом лишається сам ID, а колонку G ChatGPT переписує своїм
// шаблоном. Тому видобування має працювати саме з промту.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnPrompt, extractOwnStory } from '../src/own.js';

test('текст власника повертається з промту без лапок', () => {
  const story = 'Під Бакотською затокою лежить село.\nЙого затопили у 1981 році.';
  const prompt = buildOwnPrompt({ rowId: 'OWN-20260814-1200', story, photoCount: 0 });
  assert.equal(extractOwnStory(prompt), story);
});

test('фото без тексту — видобувати нічого', () => {
  const prompt = buildOwnPrompt({ rowId: 'OWN-20260814-1200', story: '', photoCount: 3 });
  assert.equal(extractOwnStory(prompt), '');
});

test('переписана ChatGPT колонка G не дає хибного тексту', () => {
  // Після обробки в G лежить шаблон «ЗАТВЕРДЖЕНИЙ СЦЕНАРІЙ», а не розповідь.
  // Тут має повернутися порожньо, щоб сервер підставив розібрані слайди.
  const rewritten = 'ЗАТВЕРДЖЕНИЙ СЦЕНАРІЙ. Тему НЕ придумуй.\n\nТЕМА: Щось\n1. РЯДОК.';
  assert.equal(extractOwnStory(rewritten), '');
});

test('порожній і невизначений промт не ламають розбір', () => {
  assert.equal(extractOwnStory(''), '');
  assert.equal(extractOwnStory(undefined), '');
  assert.equal(extractOwnStory(null), '');
});
