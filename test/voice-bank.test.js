import test from 'node:test';
import assert from 'node:assert/strict';
import {
  factWordForm, introTitle, introLine, factLine, factTitle,
  introKey, factKey, bankPlan, driveName, clipPath,
} from '../src/voice-bank.js';

test('форма слова «факт» під числом', () => {
  assert.equal(factWordForm(1), 'факт');
  assert.equal(factWordForm(2), 'факти');
  assert.equal(factWordForm(4), 'факти');
  assert.equal(factWordForm(5), 'фактів');
  assert.equal(factWordForm(15), 'фактів');
  assert.equal(factWordForm(21), 'факт');
  assert.equal(factWordForm(23), 'факти');
});

test('11–14 беруть множину, попри одиницю на кінці', () => {
  for (const n of [11, 12, 13, 14]) assert.equal(factWordForm(n), 'фактів');
  assert.equal(factWordForm(111), 'фактів');
});

test('вступ називає кількість і тему', () => {
  assert.equal(introLine(15), 'У цьому відео 15 фактів про Україну. Почнімо.');
  assert.equal(introLine(3), 'У цьому відео 3 факти про Україну. Почнімо.');
  assert.equal(introTitle(15), '15 ФАКТІВ');
  assert.equal(introTitle(2), '2 ФАКТИ');
});

test('оголошення читається порядковим числівником', () => {
  assert.equal(factLine(1), 'Факт перший.');
  assert.equal(factLine(2), 'Факт другий.');
  assert.equal(factLine(3), 'Факт третій.');
  assert.equal(factLine(4), 'Факт четвертий.');
  assert.equal(factLine(21), 'Факт двадцять перший.');
  // Наголос у порядкових числівниках проставлений навмисно — саме його TTS
  // читає правильно (деся́тий, а не де́сятий).
  assert.match(factLine(10), /Факт деся́тий\./u);
  assert.match(factLine(15), /Факт п'ятна́дцятий\./u);
});

test('напис на картці — коротке «ФАКТ N»', () => {
  assert.equal(factTitle(7), 'ФАКТ 7');
});

test('ключі стабільні: та сама репліка — той самий файл', () => {
  assert.equal(introKey(15), 'intro-15');
  assert.equal(factKey(3), 'fact-03');
  assert.equal(factKey(12), 'fact-12');
  assert.equal(driveName(factKey(3)), 'voice-fact-03.mp3');
  assert.match(clipPath(factKey(3)), /assets\/voice\/fact-03\.mp3$/);
});

test('план банку покриває і вступи, і всі оголошення', () => {
  const plan = bankPlan({ maxFacts: 5 });
  const keys = plan.map((p) => p.key);
  assert.deepEqual(keys, [
    'intro-2', 'intro-3', 'intro-4', 'intro-5',
    'fact-01', 'fact-02', 'fact-03', 'fact-04', 'fact-05',
  ]);
  assert.equal(plan.find((p) => p.key === 'fact-03').text, 'Факт третій.');
  // Ключі не повторюються — інакше одна репліка перетирала б іншу.
  assert.equal(new Set(keys).size, keys.length);
});
