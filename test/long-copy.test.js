// Промти, які власник копіює кнопкою. Найдорожча помилка тут — незамінений
// шматок шаблону: людина вставить його в ChatGPT і отримає картинку не про те.
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPromptVideo, previewPromptYouTube, hookPrompt, HOOK_WORD_LIMIT } from '../src/long-copy.js';

const SET = {
  title: '5 замків України',
  theme: 'середньовічні укріплення, що збереглися до сьогодні',
  items: [
    { title: 'Хотинська фортеця: замок, який ти бачив у десятках фільмів' },
    { title: 'Замок тамплієрів на Закарпатті, якого не було' },
  ],
};

for (const [name, build] of [['відео', previewPromptVideo], ['YouTube', previewPromptYouTube]]) {
  test(`промт прев'ю (${name}) несе тему й сюжети`, () => {
    const p = build(SET);
    assert.match(p, /5 замків України/);
    assert.match(p, /середньовічні укріплення/);
    assert.match(p, /Хотинська фортеця/);
    assert.match(p, /Замок тамплієрів/);
  });

  test(`промт прев'ю (${name}) забороняє текст у кадрі`, () => {
    assert.match(build(SET), /ЖОДНОГО ТЕКСТУ|ПРО ЛІТЕРИ/);
  });

  test(`у промті прев'ю (${name}) не лишилось порожніх підстановок`, () => {
    const p = build(SET);
    assert.doesNotMatch(p, /undefined|\[object|\$\{/);
  });
}

test('вертикальне прев\'ю просить саме 9:16, а YouTube — 16:9', () => {
  assert.match(previewPromptVideo(SET), /1080×1920/);
  assert.doesNotMatch(previewPromptVideo(SET), /1280×720/);
  assert.match(previewPromptYouTube(SET), /1280×720/);
});

test('промт хука забороняє «у цьому відео» й тримає межу в словах', () => {
  const p = hookPrompt(SET);
  assert.match(p, /не починай з «у цьому відео»/);
  assert.match(p, new RegExp(`${HOOK_WORD_LIMIT} слів`));
  assert.match(p, /5 замків України/);
});

test('порожній набір сюжетів не ламає промт', () => {
  const p = previewPromptVideo({ title: 'Тема', theme: 'опис', items: [] });
  assert.doesNotMatch(p, /undefined/);
});
