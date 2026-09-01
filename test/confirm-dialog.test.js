// Діалог підтвердження в мінідодатку. Telegram приймає щонайбільше 256
// символів; довший текст діалог не відкриває, і зворотний виклик не приходить
// НІКОЛИ — обіцянка лишається невиконаною, а кнопка мовчить: ані дії, ані
// помилки. Саме так «Відхилити» перестало працювати на рядку, де ChatGPT
// зсунув колонки й у назву теми потрапив увесь сценарій.
//
// Код живе в HTML, тож витягуємо з нього рівно ці дві функції й ганяємо їх.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../web/public/index.html', import.meta.url), 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];

function load() {
  const body = `
    let tg = null;
    ${src.match(/const CONFIRM_LIMIT[\s\S]*?^    }/m)[0]}
    ${src.match(/const HEAD_LIMIT[\s\S]*?^    }/m)[0]}
    return { askConfirm, headline, CONFIRM_LIMIT, setTg: (v) => { tg = v; } };
  `;
  return new Function(body)();
}

const SCRIPT = `МАРІЯ ПРИМАЧЕНКО ХОДИЛА НА МИЛИЦЯХ, А ЇЇ ЗВІРІ ОБЛЕТІЛИ СВІТ.\n${
  'У ДИТИНСТВІ ВОНА ПЕРЕХВОРІЛА НА ПОЛІОМІЄЛІТ І ПЕРЕСУВАЛАСЯ З МИЛИЦЯМИ. '.repeat(20)}`;

test('заголовок картки — перший рядок, а не весь сценарій', () => {
  const api = load();
  assert.ok(SCRIPT.length > 1000, 'зразок має бути справді довгим');
  const head = api.headline(SCRIPT);
  assert.ok(head.length <= 80, `задовгий заголовок: ${head.length}`);
  assert.match(head, /^МАРІЯ ПРИМАЧЕНКО/);
  assert.doesNotMatch(head, /\n/);
});

test('питання ріжеться до межі Telegram', async () => {
  const api = load();
  const seen = [];
  api.setTg({ showConfirm(msg, cb) { seen.push(msg); cb(true); } });
  const ok = await api.askConfirm(`Прибрати «${SCRIPT}» з таблиці?`);
  assert.equal(ok, true);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].length <= api.CONFIRM_LIMIT, `не обрізано: ${seen[0].length}`);
  assert.ok(seen[0].length < 256, 'Telegram довше не відкриє');
});

test('коли Telegram відмовляє, питаємо звичайним вікном', async () => {
  const api = load();
  api.setTg({ showConfirm() { throw new Error('WebAppPopupOpened'); } });
  let asked = false;
  globalThis.window = { confirm: () => { asked = true; return true; } };
  assert.equal(await api.askConfirm('Прибрати?'), true);
  assert.equal(asked, true, 'відкату не сталося — кнопка знову зависла б');
});

test('одна відповідь, навіть якщо Telegram покличе двічі', async () => {
  const api = load();
  api.setTg({ showConfirm(msg, cb) { cb(true); cb(false); } });
  assert.equal(await api.askConfirm('Прибрати?'), true);
});

test('запобіжник від загубленої відповіді існує', () => {
  // Найгірший випадок: діалог не відкрився і не кинув помилку. Без таймера
  // обіцянка висіла б вічно, а кнопка так і не ожила б.
  assert.match(src, /CONFIRM_STUCK_MS/);
  assert.match(src, /setTimeout\(\(\) => finish\(false\), CONFIRM_STUCK_MS\)/);
});
