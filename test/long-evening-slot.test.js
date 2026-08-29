// Вечір дня довгої збірки. Найтонше місце всієї затії: черга в автопублікації
// СПІЛЬНА на всі платформи й тримає ролик доти, доки він потрібен хоч комусь.
// Тому мало не опублікувати сюжет на YouTube сьогодні — треба ще й зробити
// так, щоб завтра черга не віддала його туди як «ще не опублікований».
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_CHAT_ID = '1';
process.env.ENABLE_TIKTOK = '1';
process.env.ENABLE_IG = '1';
process.env.ENABLE_YOUTUBE = '1';
process.env.AUTO_PUBLISH_HOURS = '8,12,18';

const { runAutoPublishOnce } = await import('../src/autopublish.js');

function readyItem(id) {
  return {
    id,
    title: `Тема ${id}`,
    description: `Опис ${id}`,
    archive: 'https://drive.google.com/file/d/archive/view',
    status: 'DONE',
  };
}

function harness(ids) {
  const items = ids.map(readyItem);
  const files = new Map(ids.map((id, i) => [
    `${id}.mp4`, { id: `file-${i}`, name: `${id}.mp4`, appProperties: {} },
  ]));
  const posts = [];
  const writes = [];
  return {
    items,
    files,
    posts,
    writes,
    deps: {
      listItems: async () => items,
      listFiles: async () => files,
      // Мітки одразу лягають на локальну копію — як це робить Drive у житті.
      setProperties: async (fileId, patch) => {
        writes.push({ fileId, patch });
        for (const file of files.values()) {
          if (file.id === fileId) Object.assign(file.appProperties, patch);
        }
      },
      publishPlatform: async (platform, payload) => {
        posts.push({ platform, itemId: payload.itemId ?? null });
        return { platform, status: 'published', id: `${platform}-1` };
      },
      notifyFn: async () => {},
      publicUrl: 'https://app.example.com',
    },
  };
}

// 2026-08-30 — неділя. 15:00 UTC = 18:00 у Києві.
const NEDILYA_18 = new Date('2026-08-30T15:00:00Z');
const PONEDILOK_08 = new Date('2026-08-31T05:00:00Z');
const SEREDA_18 = new Date('2026-09-02T15:00:00Z');

test('увечері дня збірки сюжет іде в TikTok та Instagram, але не на YouTube', async () => {
  const h = harness(['AUTO-20260801-0900', 'AUTO-20260802-0900']);
  await runAutoPublishOnce({ now: NEDILYA_18, ...h.deps });

  const platforms = h.posts.map((p) => p.platform).sort();
  assert.deepEqual(platforms, ['instagram', 'tiktok']);
  assert.ok(!platforms.includes('youtube'), 'на YouTube увечері виходить сама збірка');
});

test('той самий сюжет не піде на YouTube і Facebook НІКОЛИ', async () => {
  const h = harness(['AUTO-20260801-0900', 'AUTO-20260802-0900']);
  await runAutoPublishOnce({ now: NEDILYA_18, ...h.deps });

  const marked = h.files.get('AUTO-20260801-0900.mp4').appProperties;
  assert.ok(marked.youtubeSkipped, 'без мітки черга віддала б ролик YouTube завтра');
  assert.ok(marked.facebookSkipped, 'нагадування про Facebook теж має його оминути');

  // Наступний ранок: черга мусить перейти до НАСТУПНОГО сюжету, а не
  // повернутися до вчорашнього вечірнього.
  h.posts.length = 0;
  const morning = await runAutoPublishOnce({ now: PONEDILOK_08, ...h.deps });
  assert.equal(morning.itemId, 'AUTO-20260802-0900');
  assert.ok(h.posts.some((p) => p.platform === 'youtube'), 'ранковий іде на всі чотири');
});

test('у звичайний день вечірній слот YouTube працює як завжди', async () => {
  const h = harness(['AUTO-20260801-0900']);
  await runAutoPublishOnce({ now: SEREDA_18, ...h.deps });

  assert.ok(h.posts.some((p) => p.platform === 'youtube'));
  assert.ok(!h.files.get('AUTO-20260801-0900.mp4').appProperties.youtubeSkipped);
});

test('скасована добірка повертає вечірній слот YouTube', async () => {
  // Прев'ю не приїхало до 16:00 — довгого відео сьогодні не буде, тож шортс
  // о 18:00 має вийти на всі платформи, як у звичайний день.
  const h = harness(['AUTO-20260801-0900']);
  await runAutoPublishOnce({ now: NEDILYA_18, compilationOn: false, ...h.deps });

  assert.ok(h.posts.some((p) => p.platform === 'youtube'));
  assert.ok(!h.files.get('AUTO-20260801-0900.mp4').appProperties.youtubeSkipped);
});

test('добірка в силі — слот лишається за нею', async () => {
  const h = harness(['AUTO-20260801-0900']);
  await runAutoPublishOnce({ now: NEDILYA_18, compilationOn: true, ...h.deps });

  assert.ok(!h.posts.some((p) => p.platform === 'youtube'));
  assert.ok(h.files.get('AUTO-20260801-0900.mp4').appProperties.youtubeSkipped);
});
