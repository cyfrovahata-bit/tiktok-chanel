// Межа кількості фото має збігатися з промтом сценарію. Коли промт дозволив
// 10–12 слайдів, а тут лишалося 10, ChatGPT малював законні 11 кадрів — і
// монтаж відкидав готовий архів після трьох спроб.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIN_PHOTOS, MAX_PHOTOS } from '../src/archive.js';

test('межа фото покриває діапазон слайдів із промту', () => {
  const prompt = readFileSync(new URL('../prompts/promt-scenariy-v3.md', import.meta.url), 'utf8');
  const m = /(\d+)–(\d+) слайдів, з них ОСТАННІЙ — заклик/.exec(prompt);
  assert.ok(m, 'у промті не знайдено рядка з кількістю слайдів');
  const [, low, high] = m.map(Number);
  assert.ok(MIN_PHOTOS <= low, `MIN_PHOTOS ${MIN_PHOTOS} більший за нижню межу промту ${low}`);
  assert.ok(MAX_PHOTOS >= high, `MAX_PHOTOS ${MAX_PHOTOS} менший за верхню межу промту ${high}`);
});
