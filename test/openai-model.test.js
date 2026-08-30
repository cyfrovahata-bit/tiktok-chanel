// Модель передається окремим параметром і мусить перекривати стандартну.
// Якщо колись переставити місцями поля в тілі запиту, вступ добірки тихо
// поїде на gpt-4o-mini — і помітно це буде лише за якістю тексту.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatOnce } from '../src/openai.js';

function withFakeFetch(reply, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push(JSON.parse(options.body));
    return { ok: true, json: async () => reply };
  };
  return fn(seen).finally(() => { globalThis.fetch = real; });
}

const OK = { choices: [{ message: { content: 'відповідь' } }] };

test('без параметра йде стандартна модель каналу', async () => {
  process.env.OPENAI_API_KEY = 'test';
  await withFakeFetch(OK, async (seen) => {
    await chatOnce('привіт');
    assert.equal(seen[0].model, 'gpt-4o-mini');
  });
});

test('передана модель перекриває стандартну', async () => {
  process.env.OPENAI_API_KEY = 'test';
  await withFakeFetch(OK, async (seen) => {
    await chatOnce('привіт', { model: 'gpt-4o' });
    assert.equal(seen[0].model, 'gpt-4o');
    assert.equal(seen[0].messages[0].content, 'привіт');
  });
});
