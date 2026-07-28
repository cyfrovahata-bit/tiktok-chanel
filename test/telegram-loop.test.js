import test from 'node:test';
import assert from 'node:assert/strict';
import { pollUpdatesOnce } from '../src/telegram-loop.js';

test('оновлення розкладаються по обробниках, offset рухається далі', async () => {
  const seen = [];
  const offsets = [];
  const updates = [
    { update_id: 10, callback_query: { id: 'q1', data: 'ytc:s:c1' } },
    { update_id: 11, message: { text: 'мій текст' } },
  ];

  const handled = await pollUpdatesOnce({
    getUpdates: async (offset) => { offsets.push(offset); return updates; },
    onCallback: async (cb) => seen.push(`cb:${cb.data}`),
    onMessage: async (m) => seen.push(`msg:${m.text}`),
  });

  assert.equal(handled, 2);
  assert.deepEqual(seen, ['cb:ytc:s:c1', 'msg:мій текст']);
  assert.equal(offsets[0], undefined, 'перший запит — без offset');

  // Другий прохід має просити оновлення ПІСЛЯ останнього обробленого,
  // інакше ті самі натискання оброблялися б по колу.
  await pollUpdatesOnce({ getUpdates: async (offset) => { offsets.push(offset); return []; } });
  assert.equal(offsets[1], 12);
});

test('падіння одного обробника не спиняє решту оновлень', async () => {
  const seen = [];
  const handled = await pollUpdatesOnce({
    getUpdates: async () => ([
      { update_id: 20, callback_query: { id: 'q', data: 'ytc:s:bad' } },
      { update_id: 21, message: { text: 'далі' } },
    ]),
    onCallback: async () => { throw new Error('протермінований callback'); },
    onMessage: async (m) => seen.push(m.text),
  });
  assert.equal(handled, 2);
  assert.deepEqual(seen, ['далі'], 'повідомлення після збою все одно оброблено');
});

test('довге опитування: timeout передається в Telegram', async () => {
  const timeouts = [];
  await pollUpdatesOnce({
    timeout: 25,
    getUpdates: async (_offset, timeout) => { timeouts.push(timeout); return []; },
  });
  assert.deepEqual(timeouts, [25]);
});
