// Збір статистики опублікованих відео (перегляди, лайки, коментарі) і
// надсилання зведення власнику в Telegram — ЧЕРНЕТКА на майбутнє.
//
// Задум власника: публікація йде через веб-панель, а Telegram-бот
// залишається каналом ЗВОРОТНОГО зв'язку — раз на день (чи за розкладом)
// присилає, як заходять уже опубліковані ролики. Реальне збирання цифр
// вимагає тих самих API платформ, що й публікація, тож поки — заглушка,
// увімкнена флагом ENABLE_STATS.
import { ownerChatId, sendMessage } from './telegram.js';

// Збирає метрики по одному опублікованому відео з усіх платформ, куди його
// викладено. Поки повертає порожньо — реальні виклики API додаються, коли
// будуть ключі (TikTok Display API, Meta Insights, YouTube Analytics).
export async function collectStats(_publishedRefs) {
  // TODO: реальні запити метрик по кожній платформі.
  return [];
}

// Форматує й надсилає зведення статистики власнику в Telegram.
// Нічого не робить, поки ENABLE_STATS !== '1' — щоб чернетка не турбувала.
export async function reportStats(publishedRefs) {
  if (process.env.ENABLE_STATS !== '1') return;
  const stats = await collectStats(publishedRefs);
  if (stats.length === 0) return;

  const lines = stats.map(
    (s) => `${s.platform}: 👁 ${s.views ?? '—'}  ❤️ ${s.likes ?? '—'}  💬 ${s.comments ?? '—'}`,
  );
  await sendMessage(ownerChatId(), `📊 Статистика останніх відео:\n${lines.join('\n')}`);
}
