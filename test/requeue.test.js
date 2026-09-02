import test from 'node:test';
import assert from 'node:assert/strict';
import { requeueTarget } from '../src/sheets.js';
import { unpublishedPlatforms } from '../src/autopublish.js';

// Повний рядок: саме таким його бачить isReady.
const full = (over = {}) => ({
  rowNumber: 152, id: 'OWN-1', status: 'PUBLISHED',
  archive: 'https://drive/zip', title: 'Назва', description: 'Опис', ...over,
});

test('опублікований рядок повертається в чергу', () => {
  assert.deepEqual(requeueTarget([full()], 'OWN-1'), { rowNumber: 152 });
});

test('рядок уже в черзі — повернення нічого не міняє', () => {
  const out = requeueTarget([full({ status: 'DONE' })], 'OWN-1');
  assert.equal(out.alreadyQueued, true);
});

test('серед дублікатів беремо саме опублікований', () => {
  const items = [full({ rowNumber: 10, status: 'NEW' }), full({ rowNumber: 152 })];
  assert.equal(requeueTarget(items, 'OWN-1').rowNumber, 152);
});

test('NEW і ERROR не повертаємо: там ще немає що публікувати', () => {
  for (const status of ['NEW', 'ERROR']) {
    assert.throws(() => requeueTarget([full({ status })], 'OWN-1'), new RegExp(status));
  }
});

test('рядок без опису не повертається — у черзі він був би невидимим', () => {
  // isReady вимагає архів, назву й опис; без них монітор і мінідодаток рядок
  // не бачать, і «повернення» вийшло б тихим нічим.
  assert.throws(() => requeueTarget([full({ description: '' })], 'OWN-1'), /невидимим/);
});

test('невідомий ID — помилка, а не мовчазний успіх', () => {
  assert.throws(() => requeueTarget([full()], 'OWN-2'), /не знайдено/);
});

test('чекають ті платформи, де немає ID допису', () => {
  // Вечір дня збірки: шортс пішов у TikTok та Instagram, а YouTube і Facebook
  // дістали саму збірку — на файлі стоїть youtubeSkipped, і ID допису немає.
  const props = {
    instagramPostId: '178913', tiktokPostId: 'v_pub_file~v2-1.768',
    youtubeSkipped: '2026-09-01-18', facebookSkipped: '2026-09-01-18',
  };
  assert.deepEqual(
    unpublishedPlatforms(props, ['youtube', 'tiktok', 'instagram', 'facebook']),
    ['youtube', 'facebook'],
  );
});

test('мітка пропуску не вважається публікацією', () => {
  // Саме її і знімає «Повернути в чергу», тож рахувати її «вже вийшло» не можна.
  assert.deepEqual(unpublishedPlatforms({ youtubeSkipped: '2026-09-01-18' }, ['youtube']), ['youtube']);
});
