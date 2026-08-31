// Пам'ять оголошених статусів. Найдорожча помилка тут — забути рядок, який ще
// в таблиці: монітор вважає його щойно побаченим і шле «Тема на сьогодні»
// вкотре. Саме це й сталося, коли таблиця (134 рядки) переросла межу в 120:
// кожен прохід відрізав початок файлу, забуті рядки поверталися в кінець,
// зсували решту — і під ніж рано чи пізно потрапляв рядок зі статусом NEW.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneNotices } from '../src/monitor.js';

test('рядки з таблиці лишаються, зниклі — зникають', () => {
  const seen = {
    'AUTO-1': 'PUBLISHED',
    'AUTO-2': 'NEW',
    'AUTO-СТАРИЙ': 'PUBLISHED',
  };
  assert.deepEqual(pruneNotices(seen, ['AUTO-1', 'AUTO-2']), {
    'AUTO-1': 'PUBLISHED',
    'AUTO-2': 'NEW',
  });
});

test('велика таблиця не втрачає жодного рядка — саме на цьому все й ламалося', () => {
  const keys = Array.from({ length: 300 }, (_, i) => `AUTO-${i}`);
  const seen = Object.fromEntries(keys.map((k) => [k, 'PUBLISHED']));
  seen['AUTO-299'] = 'NEW';
  const out = pruneNotices(seen, keys);
  assert.equal(Object.keys(out).length, 300);
  assert.equal(out['AUTO-299'], 'NEW');
});

test('попередження живуть, поки живий їхній рядок', () => {
  const seen = {
    'AUTO-1': 'DONE',
    'fail:AUTO-1': 'https://архів.zip',
    'dupe:AUTO-1#2026-08-31': 'DONE',
    'fail:AUTO-ЗНИКЛИЙ': 'https://інший.zip',
    'dupe:AUTO-ЗНИКЛИЙ#2026-01-01': 'NEW',
  };
  const out = pruneNotices(seen, ['AUTO-1']);
  assert.deepEqual(Object.keys(out).sort(), ['AUTO-1', 'dupe:AUTO-1#2026-08-31', 'fail:AUTO-1']);
});

test('ключ рядка з номером рядка не губить своїх попереджень', () => {
  // Дублікати ID отримують ключ «ID#рядок», а попередження лишається за ID.
  const seen = { 'AUTO-1#7': 'NEW', 'fail:AUTO-1': 'zip' };
  assert.deepEqual(pruneNotices(seen, ['AUTO-1#7']), seen);
});

test('порожній вхід не ламає розбір', () => {
  assert.deepEqual(pruneNotices(undefined, []), {});
  assert.deepEqual(pruneNotices({}, ['AUTO-1']), {});
  assert.deepEqual(pruneNotices({ 'AUTO-1': 'NEW' }, []), {});
});

test('ключ-текст замість ID теж переживає прохід', () => {
  // Колонка ID у рядку буває порожня, і ключем стає сама тема. Довжина ключа
  // нічого не міняє — рядок є в таблиці, отже лишається в пам'яті.
  const theme = 'Як Марія Примаченко створила світ фантастичних звірів попри поліомієліт';
  assert.deepEqual(pruneNotices({ [theme]: 'NEW' }, [theme]), { [theme]: 'NEW' });
});
