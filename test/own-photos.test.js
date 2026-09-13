// Фото, докинуті до сюжету, який уже лежить у таблиці.
//
// Найдорожча помилка тут — розсинхрон: у промті написано «5 фото», а в папці
// їх три, або блоків стало два з різними числами. Тому перевіряємо не текст
// заради тексту, а саме те, що блок ЗАМІНЮЄТЬСЯ, а не накопичується, і що
// правка слайдів після цього все ще працює.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnPrompt, withOwnPhotos, ownPhotoBlock } from '../src/own.js';
import { parseSlideLines, applySlideLines } from '../src/queue-prompt.js';

// Те, що ChatGPT лишає в колонці G після першого промту.
const SCENARIO = `ЗАТВЕРДЖЕНИЙ СЦЕНАРІЙ. Твоє завдання — ЛИШЕ намалювати фото й зібрати архів.

ТЕМА: Хмельницький
КІЛЬКІСТЬ ФОТО: 2

ТЕКСТИ СЛАЙДІВ (рівно ці рядки й у цьому порядку йдуть у script.txt):
1. Перший рядок.
2. Другий рядок.

ДЖЕРЕЛА: https://example.org

ЩО МАЄ БУТИ НА КОЖНОМУ КАДРІ:
1.jpg — опис кадру 1
(рядок: «Перший рядок.»)
2.jpg — опис кадру 2
(рядок: «Другий рядок.»)`;

test('блок фото стає перед покадровим брифом, а не в кінці', () => {
  const out = withOwnPhotos(SCENARIO, { photoCount: 3, folderUrl: 'https://drive/x' });
  assert.match(out, /ФОТО ВЛАСНИКА \(3 шт\.\)/);
  assert.match(out, /https:\/\/drive\/x/);
  assert.ok(out.indexOf('ФОТО ВЛАСНИКА') < out.indexOf('ЩО МАЄ БУТИ НА КОЖНОМУ КАДРІ'));
  // Сам сценарій лишився недоторканим.
  assert.ok(out.includes('ТЕМА: Хмельницький'));
  assert.ok(out.includes('1.jpg — опис кадру 1'));
});

test('повторне докидання ЗАМІНЮЄ блок, а не додає другий', () => {
  const once = withOwnPhotos(SCENARIO, { photoCount: 3, folderUrl: 'https://drive/x' });
  const twice = withOwnPhotos(once, { photoCount: 7, folderUrl: 'https://drive/x' });
  assert.equal((twice.match(/ФОТО ВЛАСНИКА/g) || []).length, 1);
  assert.match(twice, /\(7 шт\.\)/);
  assert.doesNotMatch(twice, /\(3 шт\.\)/);
  assert.equal((twice.match(/кінець блоку фото/g) || []).length, 1);
});

test('нуль фото прибирає блок повністю', () => {
  const withPhotos = withOwnPhotos(SCENARIO, { photoCount: 4, folderUrl: 'https://drive/x' });
  const cleared = withOwnPhotos(withPhotos, { photoCount: 0 });
  assert.doesNotMatch(cleared, /ФОТО ВЛАСНИКА/);
  assert.doesNotMatch(cleared, /кінець блоку фото/);
  assert.ok(cleared.includes('ЩО МАЄ БУТИ НА КОЖНОМУ КАДРІ'));
});

test('промт без покадрового брифу отримує блок у кінець, а не втрачає його', () => {
  const odd = 'ЗАТВЕРДЖЕНИЙ СЦЕНАРІЙ без звичних заголовків.';
  const out = withOwnPhotos(odd, { photoCount: 2, folderUrl: 'https://drive/y' });
  assert.ok(out.startsWith(odd));
  assert.match(out, /ФОТО ВЛАСНИКА \(2 шт\.\)/);
});

test('після докидання фото слайди читаються й правляться, як і раніше', () => {
  const out = withOwnPhotos(SCENARIO, { photoCount: 3, folderUrl: 'https://drive/x' });
  assert.deepEqual(parseSlideLines(out), ['Перший рядок.', 'Другий рядок.']);
  const edited = applySlideLines(out, ['Новий перший.', 'Другий рядок.']);
  assert.deepEqual(parseSlideLines(edited), ['Новий перший.', 'Другий рядок.']);
  // Блок фото правка слайдів не чіпає.
  assert.match(edited, /ФОТО ВЛАСНИКА \(3 шт\.\)/);
  // І дубль тексту в брифі кадру теж оновився.
  assert.match(edited, /\(рядок: «Новий перший.»\)/);
});

test('правка слайдів не бачить у блоці фото зайвих рядків', () => {
  const out = withOwnPhotos(SCENARIO, { photoCount: 3, folderUrl: 'https://drive/x' });
  // У блоці є нумерований перелік ознак — він НЕ має потрапити в слайди.
  assert.equal(parseSlideLines(out).length, 2);
});

test('перший промт власника і докидання дають той самий блок', () => {
  // Інакше ChatGPT отримував би дві різні редакції тих самих вказівок
  // залежно від того, коли фото з'явилися.
  const block = ownPhotoBlock({ photoCount: 4, where: 'https://drive/z' });
  const built = buildOwnPrompt({
    rowId: 'OWN-1', story: 'Текст.', photoCount: 4, folderUrl: 'https://drive/z',
  });
  assert.ok(built.includes(block));
  assert.ok(withOwnPhotos(SCENARIO, { photoCount: 4, folderUrl: 'https://drive/z' }).includes(block));
});

test('промт малювання шукає рівно той маркер, який ставить код', async () => {
  // Найтихіший спосіб усе зламати — перейменувати маркер у own.js і забути
  // про prompts/copy-2-foto.txt: код і далі вставлятиме блок, а ChatGPT
  // шукатиме інший рядок і просто намалює все з нуля, проігнорувавши фото.
  const { readFile } = await import('node:fs/promises');
  const url = new URL('../prompts/copy-2-foto.txt', import.meta.url);
  const text = await readFile(url, 'utf8');
  const marker = ownPhotoBlock({ photoCount: 4, where: 'x' }).split('\n')[0]
    .replace(' (4 шт.) ———', '');
  assert.ok(text.includes(marker), `у промті малювання немає маркера «${marker}»`);
  assert.match(text, /ФОТО ВЛАСНИКА/);
});

test('фото, докинуті до розбору сюжету, правлять і шапку промту', () => {
  // Сюжет надіслали без знімків: у шапці стоїть «ФОТО НЕМАЄ». Якщо лишити її
  // як є, ChatGPT першого етапу виконає саме написане й до папки не зазирне.
  const p = buildOwnPrompt({ rowId: 'OWN-1', story: 'Текст.', photoCount: 0 });
  assert.match(p, /ФОТО НЕМАЄ/);
  const out = withOwnPhotos(p, { photoCount: 3, folderUrl: 'https://drive/x' });
  assert.doesNotMatch(out, /ФОТО НЕМАЄ/);
  assert.match(out, /ФОТО ВЛАСНИКА: 3 шт\. у папці Drive:\nhttps:\/\/drive\/x/);
});

test('шапка й блок показують те саме число після повторного докидання', () => {
  const p = buildOwnPrompt({
    rowId: 'OWN-1', story: 'Текст.', photoCount: 2, folderUrl: 'https://drive/x',
  });
  const out = withOwnPhotos(p, { photoCount: 6, folderUrl: 'https://drive/x' });
  assert.match(out, /ФОТО ВЛАСНИКА: 6 шт\./);
  assert.match(out, /ФОТО ВЛАСНИКА \(6 шт\.\)/);
  assert.doesNotMatch(out, /2 шт\./);
});

test('прибрані фото повертають шапку в «фото немає»', () => {
  const p = buildOwnPrompt({
    rowId: 'OWN-1', story: 'Текст.', photoCount: 2, folderUrl: 'https://drive/x',
  });
  const out = withOwnPhotos(p, { photoCount: 0 });
  assert.match(out, /ФОТО НЕМАЄ/);
  assert.doesNotMatch(out, /ФОТО ВЛАСНИКА/);
});
