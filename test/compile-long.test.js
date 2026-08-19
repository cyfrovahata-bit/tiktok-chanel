import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSilenceGaps, pickCtaCut } from '../src/compile-long.js';

const LOG = `
[silencedetect @ 0x1] silence_start: 12.4
[silencedetect @ 0x1] silence_end: 12.9 | silence_duration: 0.5
[silencedetect @ 0x1] silence_start: 41.2
[silencedetect @ 0x1] silence_end: 41.95 | silence_duration: 0.75
[silencedetect @ 0x1] silence_start: 54.8
[silencedetect @ 0x1] silence_end: 55.6 | silence_duration: 0.8
`;

test('розбирає паузи з виводу silencedetect', () => {
  assert.deepEqual(parseSilenceGaps(LOG), [
    { start: 12.4, end: 12.9 },
    { start: 41.2, end: 41.95 },
    { start: 54.8, end: 55.6 },
  ]);
});

test('незакрита пауза без silence_end до списку не потрапляє', () => {
  const gaps = parseSilenceGaps('silence_start: 3.0\nsilence_start: 7.0\nsilence_end: 7.5');
  assert.deepEqual(gaps, [{ start: 7.0, end: 7.5 }]);
});

test('ріже посередині ОСТАННЬОЇ паузи перед закликом', () => {
  const { cut, gap } = pickCtaCut(parseSilenceGaps(LOG), 62);
  assert.equal(cut, (54.8 + 55.6) / 2);
  assert.equal(gap, 0.8);
});

test('хвостову тишу за паузу не вважає', () => {
  // Остання «пауза» впирається в кінець файлу — це тиша після закінчення мови.
  const gaps = [{ start: 41.2, end: 41.95 }, { start: 55.0, end: 56.0 }];
  const { cut } = pickCtaCut(gaps, 56.4);
  assert.equal(cut, (41.2 + 41.95) / 2);
});

test('коли жодної придатної паузи немає — чесно повертає null', () => {
  assert.deepEqual(pickCtaCut([{ start: 10, end: 11 }], 11.5), { cut: null, total: 11.5, gap: null });
  assert.deepEqual(pickCtaCut([], 60), { cut: null, total: 60, gap: null });
});

import { interleave } from '../src/compile-long.js';

test('роздільники стають МІЖ епізодами, не з краю', () => {
  const parts = ['a.mp4', 'b.mp4', 'c.mp4'];
  const seps = ['s1.mp4', 's2.mp4'];
  assert.deepEqual(interleave(parts, seps),
    ['a.mp4', 's1.mp4', 'b.mp4', 's2.mp4', 'c.mp4']);
});

test('на одному епізоді роздільників немає', () => {
  assert.deepEqual(interleave(['a.mp4'], []), ['a.mp4']);
});

test('порядок епізодів зберігається', () => {
  const parts = ['1', '2', '3', '4'];
  const out = interleave(parts, ['x', 'y', 'z']);
  assert.deepEqual(out.filter((p) => parts.includes(p)), parts);
});
