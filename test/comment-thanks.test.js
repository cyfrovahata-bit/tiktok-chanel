// Автовідповіді на короткі подяки. Найдорожча помилка тут — відповісти
// «дякуємо!» там, де людина насправді вказала на помилку: це публічно й
// виглядає як знущання. Тому межа проходить по сумніву: найменший — до власника.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isShortAppreciation, thanksReply, THANKS, INVITES } from '../src/comment-thanks.js';

test('самі емодзі — відповідаємо самі', () => {
  for (const text of ['❤️', '👍👍', '🔥', '😍❤️🔥', '...', '!!!']) {
    assert.equal(isShortAppreciation(text), true, text);
  }
});

test('короткі подяки й схвалення — відповідаємо самі', () => {
  for (const text of [
    'Дякую!', 'дякую', 'Спасибі', 'Клас 👍', 'супер', 'дуже цікаво',
    'Не знав, дякую', 'Пізнавально', 'Круто!', 'Вау', 'Молодці',
    'Дякую за ролик, дуже пізнавально',
  ]) {
    assert.equal(isShortAppreciation(text), true, text);
  }
});

test('питання — завжди власникові', () => {
  for (const text of ['А де це?', 'Цікаво, а звідки дані?', 'Дякую! А коли наступне?']) {
    assert.equal(isShortAppreciation(text), false, text);
  }
});

test('подяка з зауваженням — власникові, а не «дякуємо!»', () => {
  // Саме заради цього випадку тут правила, а не модель.
  assert.equal(isShortAppreciation('Дякую, але у вас помилка в даті'), false);
  assert.equal(isShortAppreciation('Цікаво, проте насправді було не так'), false);
  assert.equal(isShortAppreciation('Клас, хоча джерело сумнівне'), false);
});

test('факти, числа й посилання — власникові', () => {
  assert.equal(isShortAppreciation('Дякую, 1941 рік'), false);
  assert.equal(isShortAppreciation('супер https://example.com'), false);
  assert.equal(isShortAppreciation('дякую @сторінка'), false);
});

test('образи та ярлики автовідповіді не отримують', () => {
  for (const text of ['фігня', 'маячня', 'нецікаво', 'тупо']) {
    assert.equal(isShortAppreciation(text), false, text);
  }
});

test('довгий змістовний коментар — власникові', () => {
  assert.equal(isShortAppreciation(
    'Дякую, дуже цікаво, я колись бував у тих місцях і бачив усе на власні очі',
  ), false);
});

test('порожнє не проходить', () => {
  assert.equal(isShortAppreciation(''), false);
  assert.equal(isShortAppreciation('   '), false);
});

// --- Тексти ------------------------------------------------------------------

test('відповідь дякує й запрошує лишатися', () => {
  const text = thanksReply({ id: 'c1', text: 'дякую' });
  assert.match(text, /[Дд]якуємо|[Рр]аді|[Пп]риємно/);
  assert.match(text, /лишайтеся|попереду|заходьте|цікав/);
});

test('та сама репліка на той самий коментар — щоб повтор проходу не дав двох різних', () => {
  assert.equal(thanksReply({ id: 'c1' }), thanksReply({ id: 'c1' }));
});

test('різні коментарі отримують різні відповіді', () => {
  const texts = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => thanksReply({ id })));
  assert.ok(texts.size >= 5, `однакових забагато: ${[...texts].join(' | ')}`);
});

test('під одним дописом відповідь не повторюється', () => {
  const first = thanksReply({ id: 'x1' });
  const second = thanksReply({ id: 'x1' }, { recent: [first] });
  assert.notEqual(second, first);
});

test('варіантів вистачає, щоб не крутитися по колу', () => {
  assert.ok(THANKS.length >= 10 && INVITES.length >= 6);
});

test('заперечена похвала — не похвала', () => {
  // «нецікаво» містить «цікав», але означає протилежне. Так само «не супер».
  for (const text of ['нецікаво', 'не цікаво', 'не супер', 'не сподобалось', 'не круто']) {
    assert.equal(isShortAppreciation(text), false, text);
  }
});

test('«не знав» і «вперше чую» — це похвала, а не заперечення', () => {
  for (const text of ['Не знав', 'не знала цього', 'Вперше чую!']) {
    assert.equal(isShortAppreciation(text), true, text);
  }
});

test('питання БЕЗ знака питання — теж власникові', () => {
  // Знак питання ставлять не всі, а «цікаво а де це» у відповідь на «дякуємо!»
  // виглядає як знущання.
  for (const text of ['цікаво а де це', 'Дякую а що далі', 'дякую де це', 'клас а коли ще']) {
    assert.equal(isShortAppreciation(text), false, text);
  }
});

test('подяка з незнайомим словом іде власникові, а не вгадується', () => {
  assert.equal(isShortAppreciation('Дякую, мій дід там працював'), false);
  assert.equal(isShortAppreciation('Супер, надішліть джерело'), false);
});

test('звичайні подяки при цьому лишаються автоматичними', () => {
  for (const text of [
    'Дякую!', 'дуже цікаво', 'Дякую за ролик', 'Дякую за відео, дуже цікаво',
    'Клас 👍', 'супер робота', 'Молодці, гарний контент', '❤️',
  ]) {
    assert.equal(isShortAppreciation(text), true, text);
  }
});

// --- Режим перевірки ---------------------------------------------------------
// Поки автовідповіді вимкнені, короткі подяки мають доходити до власника — але
// вже з готовим текстом, а не порожні: інакше він не побачить, що саме бот
// постив би після вмикання.
import { checkPlatform } from '../src/comment-flow.js';

function fakeAdapter(comments, posted) {
  return {
    key: 'fb',
    label: 'Facebook',
    icon: '💬',
    enabled: () => true,
    fetch: async () => comments,
    reply: async (id, text) => { posted.push({ id, text }); },
    link: () => 'https://example.com/post',
  };
}

test('без вмикання нічого не публікується — усе йде карткою', async () => {
  const posted = [];
  const cards = [];
  const state = { seen: {}, drafts: {} };
  const result = await checkPlatform(fakeAdapter([
    { id: 'c1', text: 'Дякую!', author: 'Іван', postId: 'p1' },
    { id: 'c2', text: '❤️', author: 'Оля', postId: 'p1' },
  ], posted), {
    state,
    postIndex: [],
    notifyFn: async (_chat, text) => { cards.push(text); return { message_id: cards.length }; },
    chatId: 1,
  });

  assert.equal(posted.length, 0, 'у режимі перевірки бот не має постити сам');
  assert.equal(result.auto ?? 0, 0);
  assert.equal(cards.length, 2);
});

test('картка короткої подяки несе готовий текст і позначку', async () => {
  const cards = [];
  await checkPlatform(fakeAdapter([{ id: 'c1', text: 'дуже цікаво', author: 'Іван', postId: 'p1' }], []), {
    state: { seen: {}, drafts: {} },
    postIndex: [],
    notifyFn: async (_chat, text) => { cards.push(text); return { message_id: 1 }; },
    chatId: 1,
  });

  assert.match(cards[0], /Коротка подяка/);
  assert.match(cards[0], /[Дд]якуємо|[Рр]аді|[Пп]риємно/);
  assert.match(cards[0], /лишайтеся|попереду|заходьте|цікав/);
});

// --- Лайки -------------------------------------------------------------------

function adapterWithLike(comments, log) {
  return {
    key: 'fb',
    label: 'Facebook',
    icon: '💬',
    enabled: () => true,
    fetch: async () => comments,
    reply: async (id, text) => log.push({ act: 'reply', id, text }),
    like: async (id) => log.push({ act: 'like', id }),
    link: () => 'https://example.com/post',
  };
}

test('коментар із чернеткою отримує лайк', async () => {
  const log = [];
  await checkPlatform(adapterWithLike([
    { id: 'c1', text: 'Дякую!', author: 'Іван', postId: 'p1' },
  ], log), {
    state: { seen: {}, drafts: {} },
    postIndex: [],
    notifyFn: async () => ({ message_id: 1 }),
    chatId: 1,
  });
  assert.ok(log.some((l) => l.act === 'like' && l.id === 'c1'));
});

test('там, де модель радить промовчати, лайка немає', async () => {
  // Уподобаний випад виглядав би згодою з ним.
  const log = [];
  await checkPlatform(adapterWithLike([
    { id: 'c2', text: 'тупа маячня від ботів', author: 'Тролль', postId: 'p1' },
  ], log), {
    state: { seen: {}, drafts: {} },
    postIndex: [],
    chat: async () => 'ПРОПУСТИТИ',
    notifyFn: async () => ({ message_id: 1 }),
    chatId: 1,
  });
  assert.ok(!log.some((l) => l.act === 'like'), 'випад лайкати не можна');
});

test('двічі той самий коментар не лайкається', async () => {
  const log = [];
  const state = { seen: {}, drafts: {} };
  const comments = [{ id: 'c3', text: 'супер', author: 'Іван', postId: 'p1' }];
  await checkPlatform(adapterWithLike(comments, log), {
    state, postIndex: [], notifyFn: async () => ({ message_id: 1 }), chatId: 1,
  });
  // Другий прохід: коментар уже бачений, але навіть якби ні — лайк не повториться.
  state.seen = {};
  await checkPlatform(adapterWithLike(comments, log), {
    state, postIndex: [], notifyFn: async () => ({ message_id: 1 }), chatId: 1,
  });
  assert.equal(log.filter((l) => l.act === 'like').length, 1);
});

// --- Емодзі окремо -----------------------------------------------------------
import { isEmojiOnly, EMOJI_THANKS } from '../src/comment-thanks.js';

test('коментар без слів упізнається як сама реакція', () => {
  for (const text of ['❤️🇺🇦🙏❤️🇺🇦', '👍', '🔥🔥🔥', '...']) {
    assert.equal(isEmojiOnly(text), true, text);
  }
  for (const text of ['Дякую!', 'клас 👍', '']) {
    assert.equal(isEmojiOnly(text), false, text);
  }
});

test('на самі емодзі не дякуємо за «слова» й не кажемо «приємно чути»', () => {
  // Нічого не чули — людина поставила реакцію.
  for (const id of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']) {
    const text = thanksReply({ id, text: '❤️🇺🇦' });
    assert.doesNotMatch(text, /чути|слова|написати|читати/, text);
  }
});

test('на емодзі дякуємо саме за реакцію або підтримку', () => {
  const texts = ['e1', 'e2', 'e3'].map((id) => thanksReply({ id, text: '👍' }));
  for (const text of texts) {
    assert.ok(
      EMOJI_THANKS.some((opener) => text.startsWith(opener)),
      `несподіваний зачин: ${text}`,
    );
  }
});

test('на текстову подяку зачини лишаються попередні', () => {
  const text = thanksReply({ id: 'w1', text: 'дуже цікаво' });
  assert.ok(THANKS.some((opener) => text.startsWith(opener)), text);
});

// Сторінка називається «Чи Ви Знали?» — зі знаком питання просто в назві.
// Через це «Чи Знали Ви? Дякую» поїхало власникові як запитання, а ШІ
// відповіла «дякуємо за запитання». Питання там не було жодного.
import { withoutChannelName } from '../src/comment-thanks.js';

test('назва сторінки не робить коментар запитанням', () => {
  for (const text of ['Чи Знали Ви? Дякую.', 'Чи Ви Знали? Дякую', 'чи ви знали! дякую']) {
    assert.equal(isShortAppreciation(text), true, text);
  }
});

test('сама назва сторінки — теж звернення, а не питання', () => {
  assert.equal(isShortAppreciation('Чи Знали Ви?'), true);
  assert.equal(withoutChannelName('Чи Знали Ви?'), '');
});

test('справжнє запитання після назви лишається запитанням', () => {
  assert.equal(isShortAppreciation('Чи знали ви, що насправді все не так?'), false);
  assert.equal(isShortAppreciation('Чи Ви Знали? А звідки дані?'), false);
  assert.equal(isShortAppreciation('Чи знали ви що це неправда'), false);
});

test('назва не з\'їдає решту коментаря', () => {
  assert.equal(withoutChannelName('Чи Знали Ви? Дякую.'), 'Дякую.');
  assert.match(withoutChannelName('Дякую, канал «Чи Ви Знали»!'), /^Дякую, канал/);
  assert.equal(withoutChannelName('просто текст'), 'просто текст');
});
