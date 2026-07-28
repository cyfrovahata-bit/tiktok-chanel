// Єдина точка публікації по платформах. Facebook та Instagram — через Meta
// Graph API, TikTok — через Content Posting API. YouTube поки що вручну.
import { publishFacebookReel, publishInstagramReel } from './meta.js';
import { publishTikTokVideo } from './tiktok.js';
import { publishYouTubeShort } from './youtube.js';

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
    // Байтами, а не посиланням — причина в коментарі до transferReelFile.
    const byUrl = process.env.META_UPLOAD_MODE === 'url';
    const result = await publishFacebookReel({
      videoUrl: payload.videoUrl,
      videoBuffer: byUrl || !payload.videoBuffer ? null : await payload.videoBuffer(),
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

  if (platform === 'tiktok') {
    // TikTok приймає БАЙТИ, а не посилання, тож качаємо готовий ролик до себе.
    const buffer = await payload.videoBuffer();
    const result = await publishTikTokVideo({ videoBuffer: buffer, title: caption });
    return {
      platform,
      status: 'published',
      id: result.id,
      detail: result.mode === 'direct'
        ? `TikTok ${result.id} (${result.privacy})`
        : `TikTok ${result.id} — у чернетках застосунку (скоуп video.upload)`,
    };
  }

  if (platform === 'youtube') {
    // YouTube приймає байти, як і TikTok.
    const result = await publishYouTubeShort({
      videoBuffer: await payload.videoBuffer(),
      title: payload.title,
      description: caption,
    });
    return {
      platform,
      status: 'published',
      id: result.id,
      // Приватність показуємо ту, яку повернув YouTube, а не ту, яку просили:
      // непройдений аудит мовчки перетворює public на private.
      detail: result.forcedPrivate
        ? `YouTube ${result.id} — залито ПРИВАТНО (проєкт не пройшов аудит YouTube API), опублічни в Studio`
        : `YouTube ${result.id} (${result.privacyStatus})`,
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
