// Публікація відео по платформах — ПОКИ ЗАГЛУШКИ (чернетка).
// Кожна платформа вмикається окремим флагом у міру проходження модерації
// й підключення API. Поки флаг не заданий — publish() повертає статус
// «не підключено», нічого нікуди не надсилаючи. Реальні виклики API
// (TikTok Content Posting, Meta Graph, YouTube Data) додаються сюди
// пізніше, коли будуть ключі — решта коду (веб-панель) уже готова їх звати.

// name — людська назва; flag — змінна середовища, що вмикає платформу;
// коли реальний код з'явиться, він живе у полі publish кожного запису.
const PLATFORMS = {
  tiktok: { name: 'TikTok', flag: 'ENABLE_TIKTOK' },
  facebook: { name: 'Facebook', flag: 'ENABLE_FB' },
  instagram: { name: 'Instagram', flag: 'ENABLE_IG' },
  youtube: { name: 'YouTube', flag: 'ENABLE_YOUTUBE' },
};

export function availablePlatforms() {
  return Object.entries(PLATFORMS).map(([id, p]) => ({
    id,
    name: p.name,
    enabled: process.env[p.flag] === '1',
  }));
}

// Публікує (або поки що імітує) на одну платформу.
//   platform — ключ із PLATFORMS ('tiktok'...);
//   payload  — { videoPath, title, description, hashtags }.
// Повертає { platform, status: 'published'|'skipped', detail }.
export async function publish(platform, payload) {
  const meta = PLATFORMS[platform];
  if (!meta) throw new Error(`Невідома платформа: ${platform}`);

  if (process.env[meta.flag] !== '1') {
    // Чернетка: API ще не підключено — не публікуємо, лише повідомляємо.
    return {
      platform,
      status: 'skipped',
      detail: `${meta.name}: API не підключено (задай ${meta.flag}=1 після налаштування)`,
    };
  }

  // TODO: реальний виклик API платформи. Навмисно не імітуємо успіх, поки
  // код відсутній, щоб випадково не вважати відео опублікованим.
  throw new Error(`${meta.name}: інтеграцію API ще не реалізовано`);
}

// Публікує на всі увімкнені платформи; вимкнені акуратно пропускаються.
export async function publishAll(enabledPlatformIds, payload) {
  const results = [];
  for (const id of enabledPlatformIds) {
    try {
      results.push(await publish(id, payload));
    } catch (error) {
      results.push({ platform: id, status: 'error', detail: error.message });
    }
  }
  return results;
}
