import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCallbackData } from '../src/comment-flow.js';

test('мітка кнопки: нинішній формат', () => {
  assert.deepEqual(parseCallbackData('c:s:fb:1217780308083247_98765'), {
    action: 's', platformKey: 'fb', commentId: '1217780308083247_98765',
  });
});

test('мітка кнопки: старий формат картки з часів «лише YouTube»', () => {
  // Такі картки й досі висять у чаті — кнопка мусить працювати, а не мовчати.
  assert.deepEqual(parseCallbackData('ytc:x:UgxKREWxIgDrw8w2e'), {
    action: 'x', platformKey: 'yt', commentId: 'UgxKREWxIgDrw8w2e',
  });
});

test('мітка кнопки: id із двокрапками не втрачається', () => {
  assert.equal(parseCallbackData('c:e:ig:aaa:bbb:ccc').commentId, 'aaa:bbb:ccc');
});

test('мітка кнопки: чужі натискання не наші', () => {
  assert.equal(parseCallbackData('other_theme'), null);
  assert.equal(parseCallbackData(''), null);
  assert.equal(parseCallbackData('c:s'), null);
});
