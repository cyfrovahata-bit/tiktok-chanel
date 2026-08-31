// Промти, які ChatGPT читає за посиланням. Найдорожча помилка тут — віддати
// не те: модель виконає рівно те, що прочитає, і дізнаємось ми про це вже з
// готового ролика. Тому перевіряємо, що адреси ведуть на наявні файли й що
// списком не можна витягти щось стороннє.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_PROMPTS } from '../web/server.js';

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

test('віддаються саме ті два промти, які читає ChatGPT', () => {
  assert.equal(PUBLIC_PROMPTS['tema.txt'], 'copy-1-tema.txt');
  assert.equal(PUBLIC_PROMPTS['foto.txt'], 'copy-2-foto.txt');
});

test('адресою не можна витягти сторонній файл', () => {
  // Список закритий: усе, чого в ньому немає, має давати 404, а не читання
  // з диска. Найнебезпечніші — виходи вгору по дереву.
  for (const bad of ['../package.json', '../../etc/passwd', 'server.js', '']) {
    assert.equal(PUBLIC_PROMPTS[bad], undefined, bad);
  }
});

test('промт теми справді про тему, а промт фото — про фото', async () => {
  // Переплутати файли місцями легко, а наслідок — цілий день без роликів.
  const tema = await readFile(path.join(ROOT, 'prompts', PUBLIC_PROMPTS['tema.txt']), 'utf8');
  const foto = await readFile(path.join(ROOT, 'prompts', PUBLIC_PROMPTS['foto.txt']), 'utf8');
  assert.match(tema, /сценарист/i);
  assert.match(foto, /художник/i);
  assert.notEqual(tema, foto);
});
