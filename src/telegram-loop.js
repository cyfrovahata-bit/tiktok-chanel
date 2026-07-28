// Єдиний споживач getUpdates у процесі.
//
// Telegram віддає оновлення рівно один раз на offset, тож двох опитувальників
// в одному боті бути не може — другий «з'їдав» би натискання першого. Старий
// скрипт check.js теж опитує бота, але він запускається окремо й у продакшені
// не працює; якщо колись знадобиться — вмикати треба щось одне.
import { getUpdates } from './telegram.js';
import { handleCallback, handleMessage } from './yt-comments.js';

// Довге опитування: Telegram тримає запит до 25 секунд і віддає оновлення
// щойно вони з'являються. Замість ~17 000 запитів на добу — близько 3 500,
// і кнопка спрацьовує миттєво, а не «десь за п'ять секунд».
const POLL_TIMEOUT = Number(process.env.TELEGRAM_POLL_TIMEOUT) || 25;
const RETRY_MS = 3000;

let offset = 0;
let running = false;

export async function pollUpdatesOnce(handlers = {}) {
  const onCallback = handlers.onCallback || handleCallback;
  const onMessage = handlers.onMessage || handleMessage;
  const fetchUpdates = handlers.getUpdates || getUpdates;

  const updates = await fetchUpdates(offset || undefined, handlers.timeout ?? 0);
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

// Цикл послідовний, а не на setInterval. Два одночасні getUpdates із тим самим
// offset повернули б ТЕ САМЕ натискання двічі — і під коментарем з'явилися б дві
// однакові відповіді. Наступний запит іде лише після того, як попередній
// повністю оброблено.
export function startTelegramLoop() {
  if (running) return;
  running = true;
  (async () => {
    while (running) {
      try {
        await pollUpdatesOnce({ timeout: POLL_TIMEOUT });
      } catch (error) {
        console.error('[telegram] опитування:', error.message);
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  })();
}

export function stopTelegramLoop() {
  running = false;
}
