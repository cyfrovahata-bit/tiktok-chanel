import test from 'node:test';
import assert from 'node:assert/strict';
import { folderGate } from '../src/monitor.js';

test('тека доступна — прохід іде, попереджати нема про що', () => {
  assert.deepEqual(folderGate({ ok: true }, null), { skip: false, notify: null, warned: null });
});

test('тека зникла — прохід пропускаємо й попереджаємо', () => {
  const out = folderGate({ ok: false, reason: 'File not found: 18yik_…' }, null);
  assert.equal(out.skip, true);
  assert.equal(out.notify, 'File not found: 18yik_…');
});

test('та сама причина вдруге — мовчимо, але прохід далі пропускаємо', () => {
  // Тека може бути недоступна годинами; прохід кожні три хвилини не має
  // перетворюватися на потік однакових повідомлень.
  const out = folderGate({ ok: false, reason: 'File not found' }, 'File not found');
  assert.equal(out.skip, true);
  assert.equal(out.notify, null, 'друге попередження про те саме не шлемо');
});

test('причина змінилася — попереджаємо знову', () => {
  const out = folderGate({ ok: false, reason: 'теку з відео перемістили в кошик' }, 'File not found');
  assert.equal(out.notify, 'теку з відео перемістили в кошик');
});

test('після відновлення пам\'ять про попередження скидається', () => {
  // Інакше наступна поломка з тією ж причиною пройшла б мовчки.
  assert.equal(folderGate({ ok: true }, 'File not found').warned, null);
});

test('незадана змінна — теж привід зупинити монтаж', () => {
  const out = folderGate({ ok: false, reason: 'VIDEO_FOLDER_ID не задано' }, null);
  assert.equal(out.skip, true);
  assert.match(out.notify, /VIDEO_FOLDER_ID/);
});
