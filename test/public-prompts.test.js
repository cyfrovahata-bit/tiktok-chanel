// Промти, які ChatGPT читає за посиланням. Найдорожча помилка тут — віддати
// не те: модель виконає рівно те, що прочитає, і дізнаємось ми про це вже з
// готового ролика. Тому перевіряємо, що адреси ведуть на наявні файли й що
// списком не можна витягти щось стороннє.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_PROMPTS, promptRoute, escapeHtml } from '../web/server.js';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('кожна адреса веде на наявний файл промту', async () => {
  const names = Object.keys(PUBLIC_PROMPTS);
  assert.ok(names.length >= 2, 'мають бути щонайменше тема і фото');
  for (const [url, file] of Object.entries(PUBLIC_PROMPTS)) {
    const full = path.join(ROOT, 'prompts', file);
    await access(full);
    const text = await readFile(full, 'utf8');
    assert.ok(text.trim().length > 500, `${url}: підозріло короткий промт`);
  }
});

test('адреси названі за каналом, короткі лишаються синонімами', () => {
  assert.equal(PUBLIC_PROMPTS['znaly/tema'], 'copy-1-tema.txt');
  assert.equal(PUBLIC_PROMPTS['znaly/foto'], 'copy-2-foto.txt');
  // Перше завдання вже переведене на короткі — ламати їх переїздом не можна.
  assert.equal(PUBLIC_PROMPTS.tema, PUBLIC_PROMPTS['znaly/tema']);
  assert.equal(PUBLIC_PROMPTS.foto, PUBLIC_PROMPTS['znaly/foto']);
});

test('кожен промт доступний і текстом, і сторінкою', () => {
  assert.deepEqual(promptRoute('znaly/tema.txt'), { key: 'znaly/tema', file: 'copy-1-tema.txt', raw: true });
  assert.deepEqual(promptRoute('znaly/tema'), { key: 'znaly/tema', file: 'copy-1-tema.txt', raw: false });
});

test('кутові дужки з промту не стають тегами на сторінці', () => {
  // У примітці стоїть «РУБРИКА: <код і назва>» — без екранування браузер
  // з'їсть цей шматок як невідомий тег, і промт приїде обрізаним.
  assert.equal(escapeHtml('РУБРИКА: <код і назва>'), 'РУБРИКА: &lt;код і назва&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

test('адресою не можна витягти сторонній файл', () => {
  // Список закритий: усе, чого в ньому немає, має давати 404, а не читання
  // з диска. Найнебезпечніші — виходи вгору по дереву.
  for (const bad of [
    '../package.json', '../../etc/passwd', 'server.js', '',
    'znaly/../../package.json', '../package.json.txt',
  ]) {
    assert.equal(promptRoute(bad), null, bad);
  }
});

test('промт теми справді про тему, а промт фото — про фото', async () => {
  // Переплутати файли місцями легко, а наслідок — цілий день без роликів.
  // Тримаємось ролей на початку кожного промту: вони не міняються, навіть
  // коли решту тексту власник переписує повністю.
  const tema = await readFile(path.join(ROOT, 'prompts', PUBLIC_PROMPTS['znaly/tema']), 'utf8');
  const foto = await readFile(path.join(ROOT, 'prompts', PUBLIC_PROMPTS['znaly/foto']), 'utf8');
  assert.match(tema, /Малювати не треба/i, 'промт теми нічого не малює');
  assert.match(foto, /художник/i, 'промт фото малює');
  assert.doesNotMatch(tema, /Ти — художник/i, 'схоже, файли переплутано місцями');
  assert.notEqual(tema, foto);
});

test('промт теми несе те, без чого пайплайн не працює', async () => {
  const tema = await readFile(path.join(ROOT, 'prompts', PUBLIC_PROMPTS['znaly/tema']), 'utf8');
  // ID таблиці й колонка G — дві речі, без яких другий етап не отримає нічого.
  assert.match(tema, /1-cH52PtmicqEWc-6BegDpgO6bbbOwjB8W3rPrr4boHA/);
  assert.match(tema, /КОЛОНКА G/);
  assert.match(tema, /OWN-/, 'має лишатися пріоритет власних сюжетів');
});
