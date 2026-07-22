import test from 'node:test';
import assert from 'node:assert/strict';
import { numbersToWords } from '../src/num2words-uk.js';

test('uses the requested ordinal form for the year 2000 in speech', () => {
  assert.equal(numbersToWords('У 2000 році'), 'У двох тисячному році');
  assert.equal(numbersToWords('В 2000 році'), 'В двох тисячному році');
});

test('keeps ordinary cardinal conversion outside a year phrase', () => {
  assert.equal(numbersToWords('2000 творів'), 'дві тисячі творів');
});
