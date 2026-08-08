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

test('дати вимовляються порядковим числівником, а не кількісним', () => {
  // Без цього виходило «один травня тисяча дев'ятсот вісімдесят шість року».
  assert.equal(
    numbersToWords('1 травня 1986 року'),
    "першого травня тисяча дев'ятсот вісімдесят шостого року",
  );
  assert.equal(
    numbersToWords('26 квітня 1986 року'),
    "двадцять шостого квітня тисяча дев'ятсот вісімдесят шостого року",
  );
  assert.equal(numbersToWords('11 вересня 2001 року'), 'одинадцятого вересня дві тисячі першого року');
});

test('рік у місцевому відмінку («у 1986 році»)', () => {
  assert.equal(numbersToWords('У 1986 році'), "У тисяча дев'ятсот вісімдесят шостому році");
});

test('порядковою стає лише остання ненульова складова', () => {
  assert.equal(numbersToWords('3 березня 1900 року'), "третього березня тисяча дев'ятисотого року");
  assert.equal(numbersToWords('10 жовтня 1980 року'), "десятого жовтня тисяча дев'ятсот вісімдесятого року");
});

test('звичайні числа лишаються кількісними', () => {
  assert.equal(numbersToWords('ЇХ БУЛО 15 000'), "ЇХ БУЛО п'ятнадцять тисяч");
  assert.equal(numbersToWords('ДОВЖИНА 23 КІЛОМЕТРИ'), 'ДОВЖИНА двадцять три КІЛОМЕТРИ');
});

test('порядкові з дефісом читаються порядковим числівником', () => {
  // Раніше «7-го» ставало «сім-го», і голос вимовляв «сімого» замість
  // «сьомого»: число йшло в загальну кількісну гілку, а хвіст лишався висіти.
  assert.equal(numbersToWords('7-го блока'), 'сьомого блока');
  assert.equal(numbersToWords('у 3-му цеху'), 'у третьому цеху');
  assert.equal(numbersToWords('на 20-му кілометрі'), 'на двадцятому кілометрі');
  assert.equal(numbersToWords('у 90-х роках'), "у дев'яностих роках");
});

test('хвіст із приголосною основи теж розпізнається', () => {
  // «1-ша», «2-га», «3-тя», «7-ма» — приголосну основи відкидаємо, бо
  // ordinalUkrainian будує основу сам.
  assert.equal(numbersToWords('1-ша лінія'), 'перша лінія');
  assert.equal(numbersToWords('2-га черга'), 'друга черга');
  assert.equal(numbersToWords('3-тя зміна'), 'третя зміна');
  assert.equal(numbersToWords('7-ма година'), 'сьома година');
  assert.equal(numbersToWords('4-те місце'), 'четверте місце');
});

test('мʼяка основа «треть» не ламається перед твердим голосним', () => {
  // «треть» + «ий» дало б «третьий»; правильно — «третій».
  assert.equal(numbersToWords('3-й корпус'), 'третій корпус');
  assert.equal(numbersToWords('3-го дня'), 'третього дня');
});

test('невпізнаний хвіст лишає текст незмінним', () => {
  // Краще незмінене число, ніж вигаданий відмінок.
  assert.equal(numbersToWords('3D-принтер'), '3D-принтер');
});
