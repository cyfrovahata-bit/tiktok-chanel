// Єдина точка публікації по платформах. Facebook та Instagram реалізовані
// через Meta Graph API; TikTok і YouTube навмисно лишаються ручними.
import { publishFacebookReel, publishInstagramReel } from './meta.js';

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

  const caption = String(payload.description || payload.title || '');
  if (platform === 'facebook') {
    const result = await publishFacebookReel({
      videoUrl: payload.videoUrl,
      description: caption,
    });
    return {
      platform,
      status: 'published',
      id: result.id,
      detail: `Facebook Reel ${result.id}`,
    };
  }
  if (platform === 'instagram') {
    const result = await publishInstagramReel({
      videoUrl: payload.videoUrl,
      caption,
    });
    return {
      platform,
      status: 'published',
      id: result.id,
      detail: `Instagram Reel ${result.id}`,
    };
  }

  throw new Error(`${meta.name}: лишено для ручної публікації`);
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
