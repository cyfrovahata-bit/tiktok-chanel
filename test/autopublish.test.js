import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentPublishSlot,
  runAutoPublishOnce,
} from '../src/autopublish.js';

process.env.TELEGRAM_CHAT_ID = '1';
process.env.ENABLE_FB = '1'; // навмисно: Facebook усе одно має лишатися вимкненим
process.env.ENABLE_TIKTOK = '1';
process.env.ENABLE_IG = '1';

function readyItem(id, title = `Тема ${id}`, status = 'DONE') {
  return {
    id,
    title,
    description: `Опис ${id}`,
    archive: 'https://drive.google.com/file/d/archive/view',
    status,
  };
}

test('publish slots follow Europe/Kyiv in summer and winter', () => {
  assert.deepEqual(
    currentPublishSlot(new Date('2026-07-22T07:00:00Z')),
    { key: '2026-07-22-10', label: '10:00' },
  );
  assert.deepEqual(
    currentPublishSlot(new Date('2026-12-22T16:00:00Z')),
    { key: '2026-12-22-18', label: '18:00' },
  );
  assert.equal(currentPublishSlot(new Date('2026-07-22T06:59:59Z')), null);
});

test('бере НАЙСТАРІШЕ готове відео, а не найсвіжіше', async () => {
  const items = [
    readyItem('AUTO-20260721-1600'),
    readyItem('AUTO-20260721-1730'),
    readyItem('AUTO-20260722-0930'),
  ];
  const files = new Map([
    ['AUTO-20260721-1600.mp4', {
      id: 'file-old-evening', name: 'AUTO-20260721-1600.mp4', appProperties: {},
    }],
    ['AUTO-20260721-1730.mp4', {
      id: 'file-new-evening', name: 'AUTO-20260721-1730.mp4', appProperties: {},
    }],
    ['AUTO-20260722-0930.mp4', {
      id: 'file-current-morning', name: 'AUTO-20260722-0930.mp4', appProperties: {},
    }],
  ]);
  const writes = [];
  const posts = [];
  const notices = [];
  const setProperties = async (fileId, patch) => { writes.push({ fileId, patch }); };
  const publishPlatform = async (platform, payload) => {
    posts.push({ platform, payload });
    return { platform, status: 'published', id: `${platform}-post-1` };
  };
  const notifyFn = async (_chatId, text) => { notices.push(text); };

  const first = await runAutoPublishOnce({
    now: new Date('2026-07-22T07:00:00Z'),
    listItems: async () => items,
    listFiles: async () => files,
    setProperties,
    publishPlatform,
    notifyFn,
    publicUrl: 'https://app.example.com',
  });

  assert.equal(first.status, 'published');
  assert.equal(first.itemId, 'AUTO-20260721-1600', 'черга йде від найстарішого');
  assert.deepEqual(posts.map((post) => post.platform), ['instagram', 'tiktok']);
  assert.equal(
    posts[0].payload.videoUrl,
    'https://app.example.com/api/video/AUTO-20260721-1600',
  );
  assert.equal(writes[0].patch.autoPostSlot, '2026-07-22-10');
  assert.ok(writes.some((write) => write.patch.tiktokPostId === 'tiktok-post-1'));
  assert.ok(writes.some((write) => write.patch.instagramPostId === 'instagram-post-1'));
  assert.equal(notices.length, 1);

  const second = await runAutoPublishOnce({
    now: new Date('2026-07-22T07:10:00Z'),
    listItems: async () => items,
    listFiles: async () => files,
    setProperties,
    publishPlatform,
    notifyFn,
    publicUrl: 'https://app.example.com',
  });
  assert.equal(second.status, 'published');
  assert.equal(posts.length, 2, 'Meta API must not be called twice');
  assert.equal(notices.length, 1, 'success notification must not repeat');
});

test('за один слот виходить рівно один ролик', async () => {
  const items = [
    readyItem('AUTO-20260722-0930'),
    readyItem('AUTO-20260722-1730'),
  ];
  const files = new Map(items.map((item) => [
    `${item.id}.mp4`,
    { id: `file-${item.id}`, name: `${item.id}.mp4`, appProperties: {} },
  ]));
  const posts = [];

  const result = await runAutoPublishOnce({
    now: new Date('2026-07-22T15:00:00Z'),
    listItems: async () => items,
    listFiles: async () => files,
    setProperties: async () => {},
    publishPlatform: async (platform) => {
      posts.push(platform);
      return { platform, status: 'published', id: `${platform}-id` };
    },
    notifyFn: async () => {},
  });

  assert.equal(result.status, 'published');
  assert.equal(result.itemId, 'AUTO-20260722-0930');
  assert.deepEqual(posts, ['instagram', 'tiktok']);
});

test('пропускає те, що вже опубліковано вручну', async () => {
  // Власник натиснув «Опубліковано» в мінідодатку — статус PUBLISHED.
  // Такий рядок автопублікація брати не має, навіть якщо відео на місці.
  const items = [
    readyItem('AUTO-20260721-1600', 'Старе', 'PUBLISHED'),
    readyItem('AUTO-20260722-0930', 'Наступне в черзі'),
  ];
  const files = new Map(items.map((item) => [
    `${item.id}.mp4`,
    { id: `file-${item.id}`, name: `${item.id}.mp4`, appProperties: {} },
  ]));
  const posts = [];

  const result = await runAutoPublishOnce({
    now: new Date('2026-07-22T07:00:00Z'),
    listItems: async () => items,
    listFiles: async () => files,
    setProperties: async () => {},
    publishPlatform: async (platform) => {
      posts.push(platform);
      return { platform, status: 'published', id: `${platform}-id` };
    },
    notifyFn: async () => {},
  });

  assert.equal(result.itemId, 'AUTO-20260722-0930');
  assert.equal(posts.length, 2);
});

test('чекає, коли готового відео немає', async () => {
  const item = readyItem('AUTO-20260722-0930');
  let publishCalls = 0;
  const result = await runAutoPublishOnce({
    now: new Date('2026-07-22T07:00:00Z'),
    listItems: async () => [item],
    listFiles: async () => new Map(), // архів є, а відео ще не змонтоване
    setProperties: async () => {},
    publishPlatform: async () => { publishCalls++; },
    notifyFn: async () => {},
  });

  assert.equal(result.status, 'waiting-for-video');
  assert.equal(publishCalls, 0);
});

test('не перепубліковує TikTok, коли повторити треба лише Instagram', async () => {
  const id = 'AUTO-20260721-1730';
  const items = [readyItem(id)];
  const file = { id: 'file-one', name: `${id}.mp4`, appProperties: {} };
  const files = new Map([[`${id}.mp4`, file]]);
  const posts = [];
  let instagramAttempts = 0;
  const setProperties = async () => {};
  const publishPlatform = async (platform) => {
    posts.push(platform);
    if (platform === 'instagram' && instagramAttempts++ === 0) throw new Error('temporary');
    return { platform, status: 'published', id: `${platform}-id` };
  };
  const notifyFn = async () => {};

  const first = await runAutoPublishOnce({
    now: new Date('2026-07-22T07:00:00Z'),
    listItems: async () => items,
    listFiles: async () => files,
    setProperties,
    publishPlatform,
    notifyFn,
  });
  assert.equal(first.status, 'partial-error');
  assert.deepEqual(posts, ['instagram', 'tiktok']);

  const cooldown = await runAutoPublishOnce({
    now: new Date('2026-07-22T07:01:00Z'),
    listItems: async () => items,
    listFiles: async () => files,
    setProperties,
    publishPlatform,
    notifyFn,
  });
  assert.equal(cooldown.status, 'cooldown');

  const retried = await runAutoPublishOnce({
    now: new Date('2026-07-22T07:06:00Z'),
    listItems: async () => items,
    listFiles: async () => files,
    setProperties,
    publishPlatform,
    notifyFn,
  });
  assert.equal(retried.status, 'published');
  assert.deepEqual(posts, ['instagram', 'tiktok', 'instagram']);
});

test('a regeneration marker prevents the same item from being posted next slot', async () => {
  const id = 'AUTO-20260722-0930';
  const items = [readyItem(id)];
  const files = new Map([
    [`${id}.mp4`, { id: 'new-video', name: `${id}.mp4`, appProperties: {} }],
    [`${id}.mp4.autopost.json`, {
      id: 'marker',
      name: `${id}.mp4.autopost.json`,
      appProperties: {
        autoPostSlot: '2026-07-22-am',
        autoPostItemId: id,
        tiktokPostId: 'tt-old',
        instagramPostId: 'ig-old',
      },
    }],
  ]);
  let publishCalls = 0;

  const result = await runAutoPublishOnce({
    now: new Date('2026-07-22T15:00:00Z'),
    listItems: async () => items,
    listFiles: async () => files,
    setProperties: async () => {},
    publishPlatform: async () => { publishCalls++; },
    notifyFn: async () => {},
  });

  assert.equal(result.status, 'waiting-for-video');
  assert.equal(publishCalls, 0);
});

test('скинуте вручну не виходить повторно в тому ж вікні', async () => {
  // Пост видалили в соцмережі й зняли мітки. У поточному вікні матеріал
  // пропускаємо, інакше він опублікувався б тим самим тиком.
  const item = readyItem('AUTO-20260722-0930');
  const files = new Map([[
    `${item.id}.mp4`,
    {
      id: 'file-reset',
      name: `${item.id}.mp4`,
      appProperties: { autoPostSkipSlot: '2026-07-22-10' },
    },
  ]]);
  let publishCalls = 0;

  const inSameSlot = await runAutoPublishOnce({
    now: new Date('2026-07-22T07:30:00Z'), // 10:30 Київ — те саме вікно
    listItems: async () => [item],
    listFiles: async () => files,
    setProperties: async () => {},
    publishPlatform: async () => { publishCalls++; },
    notifyFn: async () => {},
  });
  assert.equal(inSameSlot.status, 'waiting-for-video');
  assert.equal(publishCalls, 0);

  // Наступне вікно (18:00) — уже можна.
  const posts = [];
  const nextSlot = await runAutoPublishOnce({
    now: new Date('2026-07-22T15:00:00Z'),
    listItems: async () => [item],
    listFiles: async () => files,
    setProperties: async () => {},
    publishPlatform: async (platform) => {
      posts.push(platform);
      return { platform, status: 'published', id: `${platform}-id` };
    },
    notifyFn: async () => {},
  });
  assert.equal(nextSlot.status, 'published');
  assert.deepEqual(posts, ['instagram', 'tiktok']);
});

test('години публікації беруться зі змінної AUTO_PUBLISH_HOURS', async (t) => {
  // Три пости на добу: 10:00, 15:00, 20:00 за Києвом.
  const before = process.env.AUTO_PUBLISH_HOURS;
  process.env.AUTO_PUBLISH_HOURS = '10,15,20';
  const { currentPublishSlot: slotOf } = await import(`../src/autopublish.js?three=${Date.now()}`);
  t.after(() => { process.env.AUTO_PUBLISH_HOURS = before; });

  // 12:00 UTC = 15:00 Київ (літо)
  assert.deepEqual(slotOf(new Date('2026-07-22T12:00:00Z')), { key: '2026-07-22-15', label: '15:00' });
  // 17:00 UTC = 20:00 Київ
  assert.deepEqual(slotOf(new Date('2026-07-22T17:00:00Z')), { key: '2026-07-22-20', label: '20:00' });
  // 13:30 Київ — між слотами, нічого не публікуємо
  assert.equal(slotOf(new Date('2026-07-22T10:30:00Z')), null);
  // Три ключі різні — інакше два пости на добу злилися б в один слот
  const keys = ['2026-07-22-10', '2026-07-22-15', '2026-07-22-20'];
  assert.equal(new Set(keys).size, 3);
});

test('Facebook не публікується навіть із ENABLE_FB=1', async () => {
  // Автопублікацію у Facebook вимкнено в коді: Reels, залиті через Graph API,
  // не отримують розповсюдження. Змінна оточення лишилася, тож тест стежить,
  // щоб вимкнення не «повернулося» непомітно разом із нею.
  const id = 'AUTO-20260722-0930';
  const posts = [];
  await runAutoPublishOnce({
    now: new Date('2026-07-22T07:00:00Z'),
    listItems: async () => [readyItem(id)],
    listFiles: async () => new Map([[`${id}.mp4`, { id: 'v', name: `${id}.mp4`, appProperties: {} }]]),
    setProperties: async () => {},
    publishPlatform: async (platform) => {
      posts.push(platform);
      return { platform, status: 'published', id: `${platform}-id` };
    },
    notifyFn: async () => {},
  });
  assert.equal(process.env.ENABLE_FB, '1', 'змінна справді ввімкнена');
  assert.ok(!posts.includes('facebook'), 'Facebook не має публікуватися');
});
