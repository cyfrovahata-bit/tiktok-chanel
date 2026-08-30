import test from 'node:test';
import assert from 'node:assert/strict';
import {
  factWordForm, storyWordForm, introTitle, introLine, INTRO_VARIANTS, factLine, factTitle,
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

test('вступ називає кількість і не переказує зміст', () => {
  assert.equal(introLine(15), 'Чи знав ти таку Україну? 15 історій, яких ти, можливо, не чув.');
  assert.equal(introLine(3), 'Чи знав ти таку Україну? 3 історії, яких ти, можливо, не чув.');
  assert.equal(introTitle(15), '15 ФАКТІВ');
  assert.equal(introTitle(2), '2 ФАКТИ');
});

test('варіанти вступу різні, але кожен називає кількість', () => {
  const seen = new Set();
  INTRO_VARIANTS.forEach((_, i) => {
    const line = introLine(5, i);
    assert.match(line, /5 історій/, `варіант ${i} загубив кількість`);
    // Ні запитань «чи знаєш ти, що…», ні обіцянок — це вже пробували.
    assert.doesNotMatch(line, /ще більше|покажемо|здивує/);
    assert.ok(line.length <= 70, `варіант ${i} задовгий: ${line.length}`);
    seen.add(line);
  });
  assert.equal(seen.size, INTRO_VARIANTS.length, 'варіанти повторюються');
});

test('номер варіанта ходить по колу й не вилітає за межі', () => {
  assert.equal(introLine(5, INTRO_VARIANTS.length), introLine(5, 0));
  assert.equal(introLine(5, -1), introLine(5, INTRO_VARIANTS.length - 1));
  assert.equal(introLine(5), introLine(5, 0));
});

test('форма слова «історія» узгоджується з числом', () => {
  assert.equal(storyWordForm(1), 'історія');
  assert.equal(storyWordForm(3), 'історії');
  assert.equal(storyWordForm(5), 'історій');
  assert.equal(storyWordForm(15), 'історій');
  assert.equal(storyWordForm(12), 'історій');
  assert.equal(storyWordForm(22), 'історії');
});

test('кожен варіант має власну репліку в банку', () => {
  // Ключ несе хеш тексту, тож два різні варіанти не можуть узяти один mp3.
  const keys = INTRO_VARIANTS.map((_, i) => introKey(5, introLine(5, i)));
  assert.equal(new Set(keys).size, keys.length);
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
  assert.equal(withOldWording, introKey(2, introLine(2, 0)));
  assert.notEqual(introKey(2).slice('intro-2-'.length), introKey(3).slice('intro-3-'.length));
});

test('план банку покриває кожен варіант вступу на кожен розмір', () => {
  const plan = bankPlan({ maxFacts: 5, minFacts: 4 });
  const keys = plan.map((p) => p.key);
  assert.equal(keys.length, 2 * INTRO_VARIANTS.length);   // розміри 4 і 5
  for (const n of [4, 5]) {
    for (let v = 0; v < INTRO_VARIANTS.length; v++) {
      const text = introLine(n, v);
      assert.ok(plan.some((r) => r.key === introKey(n, text) && r.text === text),
        `немає варіанта ${v} на ${n}`);
    }
  }
  // Ключі не повторюються — інакше одна репліка перетирала б іншу.
  assert.equal(new Set(keys).size, keys.length);
});

test('оголошення фактів у план не йдуть, доки диктор між ними мовчить', () => {
  assert.equal(bankPlan({ maxFacts: 5, minFacts: 5 }).some((p) => p.key.startsWith('fact-')), false);
  const withFacts = bankPlan({ maxFacts: 5, minFacts: 5, facts: true });
  assert.equal(withFacts.find((p) => p.key === factKey(3)).text, 'Факт третій.');
});
