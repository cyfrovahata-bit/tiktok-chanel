// Єдиний споживач getUpdates у процесі.
//
// Telegram віддає оновлення рівно один раз на offset, тож двох опитувальників
// в одному боті бути не може — другий «з'їдав» би натискання першого. Старий
// скрипт check.js теж опитує бота, але він запускається окремо й у продакшені
// не працює; якщо колись знадобиться — вмикати треба щось одне.
import { getUpdates } from './telegram.js';
import { handleCallback, handleMessage } from './yt-comments.js';

const POLL_MS = Number(process.env.TELEGRAM_POLL_MS) || 5000;

let offset = 0;
let timer = null;

export async function pollUpdatesOnce(handlers = {}) {
  const onCallback = handlers.onCallback || handleCallback;
  const onMessage = handlers.onMessage || handleMessage;
  const fetchUpdates = handlers.getUpdates || getUpdates;

  const updates = await fetchUpdates(offset || undefined);
  for (const update of updates || []) {
    offset = Math.max(offset, Number(update.update_id) + 1);
    try {
      if (update.callback_query) await onCallback(update.callback_query);
      else if (update.message) await onMessage(update.message);
    } catch (error) {
      // Одне зіпсоване оновлення не має спиняти решту: протермінований
      // callback_query — звична річ після перезапуску процесу.
      console.error('[telegram] оновлення:', error.message);
    }
  }
  return (updates || []).length;
}

export function startTelegramLoop() {
  if (timer) return;
  const tick = async () => {
    try { await pollUpdatesOnce(); }
    catch (error) { console.error('[telegram] опитування:', error.message); }
  };
  timer = setInterval(tick, POLL_MS);
  tick();
}
