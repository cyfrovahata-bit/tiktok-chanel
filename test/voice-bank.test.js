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

test('вступ ставить питання й називає кількість', () => {
  assert.equal(introLine(15), 'Чи знав ти таку Україну? 15 фактів, яких ти, можливо, не знав.');
  assert.equal(introLine(3), 'Чи знав ти таку Україну? 3 факти, яких ти, можливо, не знав.');
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
  assert.equal(introKey(15), introKey(15));
  assert.equal(factKey(3), factKey(3));
  assert.match(introKey(15), /^intro-15-[0-9a-f]{6}$/);
  assert.match(factKey(3), /^fact-03-[0-9a-f]{6}$/);
  assert.notEqual(factKey(3), factKey(12));
  assert.equal(driveName(factKey(3)), `voice-${factKey(3)}.mp3`);
  assert.match(clipPath(factKey(3)), new RegExp(`assets/voice/${factKey(3)}\\.mp3$`));
});

test('змінений текст репліки дає ІНШИЙ ключ', () => {
  // Саме заради цього в ключі хвіст із хеша: інакше після виправлення тексту
  // збірка й далі підставляла б старий mp3, який лежить у теці.
  const withOldWording = bankPlan({ maxFacts: 2, minFacts: 2 })[0].key;
  assert.equal(withOldWording, introKey(2));
  assert.notEqual(introKey(2).slice('intro-2-'.length), introKey(3).slice('intro-3-'.length));
});

test('план банку покриває і вступи, і всі оголошення', () => {
  const plan = bankPlan({ maxFacts: 5 });
  const keys = plan.map((p) => p.key);
  assert.deepEqual(keys, [
    introKey(2), introKey(3), introKey(4), introKey(5),
    factKey(1), factKey(2), factKey(3), factKey(4), factKey(5),
  ]);
  assert.equal(plan.find((p) => p.key === factKey(3)).text, 'Факт третій.');
  // Ключі не повторюються — інакше одна репліка перетирала б іншу.
  assert.equal(new Set(keys).size, keys.length);
});
