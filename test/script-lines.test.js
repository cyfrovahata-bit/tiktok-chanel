// script.txt має давати рівно по рядку на фото. Роздільник у файлі не завжди
import { chunkAtoms, atomize } from '../src/captions.js';
// звичайний \n — перевіряємо, що всі однозначні варіанти дають той самий
// результат, а зміст рядків не змінюється.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitScriptLines } from '../src/archive.js';

const EXPECTED = ['ПЕРШИЙ РЯДОК', 'ДРУГИЙ РЯДОК', 'ТРЕТІЙ РЯДОК'];

test('розбирає звичайні переноси рядка', () => {
  assert.deepEqual(splitScriptLines('ПЕРШИЙ РЯДОК\nДРУГИЙ РЯДОК\nТРЕТІЙ РЯДОК'), EXPECTED);
});

test('розбирає CRLF і самотній CR', () => {
  assert.deepEqual(splitScriptLines('ПЕРШИЙ РЯДОК\r\nДРУГИЙ РЯДОК\r\nТРЕТІЙ РЯДОК'), EXPECTED);
  assert.deepEqual(splitScriptLines('ПЕРШИЙ РЯДОК\rДРУГИЙ РЯДОК\rТРЕТІЙ РЯДОК'), EXPECTED);
});

test('розбирає юнікодні роздільники рядків', () => {
  assert.deepEqual(splitScriptLines('ПЕРШИЙ РЯДОК ДРУГИЙ РЯДОК ТРЕТІЙ РЯДОК'), EXPECTED);
});

test('розбирає літеральну послідовність \\n (текст записали як JSON-рядок)', () => {
  assert.deepEqual(splitScriptLines('ПЕРШИЙ РЯДОК\\nДРУГИЙ РЯДОК\\nТРЕТІЙ РЯДОК'), EXPECTED);
});

test('прибирає BOM, порожні рядки й нумерацію на початку', () => {
  assert.deepEqual(
    splitScriptLines('﻿1. ПЕРШИЙ РЯДОК\n\n2) ДРУГИЙ РЯДОК\n   \n3. ТРЕТІЙ РЯДОК\n'),
    EXPECTED,
  );
});

test('не ріже речення сам — суцільний абзац лишається одним рядком', () => {
  const paragraph = 'ПЕРШЕ РЕЧЕННЯ. ДРУГЕ РЕЧЕННЯ. ТРЕТЄ РЕЧЕННЯ.';
  assert.deepEqual(splitScriptLines(paragraph), [paragraph]);
});

test('не чіпає число всередині рядка й крапку в кінці', () => {
  assert.deepEqual(
    splitScriptLines('У 1986 РОЦІ ЦЕ ЗБУДУВАЛИ.\nЇХ БУЛО 15 000.'),
    ['У 1986 РОЦІ ЦЕ ЗБУДУВАЛИ.', 'ЇХ БУЛО 15 000.'],
  );
});

test('репліка ріжеться на фрагменти по 1–3 слова', () => {
  assert.deepEqual(
    chunkAtoms(atomize('КАЖУТЬ, СТОСУНКИ НА ВІДСТАНІ ПРИРЕЧЕНІ.'.split(/\s+/))),
    ['КАЖУТЬ,', 'СТОСУНКИ НА', 'ВІДСТАНІ ПРИРЕЧЕНІ.'],
  );
});

test('число з пробілом не розривається між фрагментами', () => {
  const chunks = chunkAtoms(atomize('ЇЙ 15 000 РОКІВ.'.split(/\s+/)));
  assert.ok(chunks.some((c) => c.includes('15 000')), `число розірвано: ${chunks.join(' | ')}`);
});

test('дрібне слово не лишається саме на екрані', () => {
  for (const chunk of chunkAtoms(atomize('У 1965 РОЦІ В КОЛБІ БУЛА РІДИНА.'.split(/\s+/)))) {
    assert.ok(chunk.replace(/[^\p{L}\p{N}]/gu, '').length >= 4, `надто короткий фрагмент: «${chunk}»`);
  }
});
