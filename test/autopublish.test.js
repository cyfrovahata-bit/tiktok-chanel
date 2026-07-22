import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentPublishSlot,
  generationSlotForItem,
  runAutoPublishOnce,
} from '../src/autopublish.js';

process.env.TELEGRAM_CHAT_ID = '1';
process.env.ENABLE_FB = '1';
process.env.ENABLE_IG = '1';

function readyItem(id, title = `Тема ${id}`) {
  return {
    id,
    title,
    description: `Опис ${id}`,
    archive: 'https://drive.google.com/file/d/archive/view',
    status: 'DONE',
  };
}

test('publish slots follow Europe/Kyiv in summer and winter', () => {
  assert.deepEqual(
    currentPublishSlot(new Date('2026-07-22T07:00:00Z')),
    { key: '2026-07-22-am', label: '10:00', generationSlot: '2026-07-21-pm' },
  );
  assert.deepEqual(
    currentPublishSlot(new Date('2026-12-22T16:00:00Z')),
    { key: '2026-12-22-pm', label: '18:00', generationSlot: '2026-12-22-am' },
  );
  assert.equal(currentPublishSlot(new Date('2026-07-22T06:59:59Z')), null);
});

test('generation slot is derived from automation ID', () => {
  assert.equal(generationSlotForItem(readyItem('AUTO-20260722-0930')), '2026-07-22-am');
  assert.equal(generationSlotForItem(readyItem('AUTO-20260722-1730')), '2026-07-22-pm');
  assert.equal(generationSlotForItem(readyItem('MANUAL-1')), null);
  assert.equal(generationSlotForItem(readyItem('AUTO-20260231-2500')), null);
});

test('10:00 publishes newest post from previous evening, not current morning', async () => {
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
  assert.equal(first.itemId, 'AUTO-20260721-1730');
  assert.deepEqual(posts.map((post) => post.platform), ['facebook', 'instagram']);
  assert.equal(
    posts[0].payload.videoUrl,
    'https://app.example.com/api/video/AUTO-20260721-1730',
  );
  assert.equal(writes[0].patch.autoPostSlot, '2026-07-22-am');
  assert.ok(writes.some((write) => write.patch.facebookPostId === 'facebook-post-1'));
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

test('18:00 publishes current morning post, not current evening', async () => {
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
  assert.deepEqual(posts, ['facebook', 'instagram']);
});

test('waits instead of publishing a post from the wrong generation slot', async () => {
  const item = readyItem('AUTO-20260722-0930');
  let publishCalls = 0;
  const result = await runAutoPublishOnce({
    now: new Date('2026-07-22T07:00:00Z'),
    listItems: async () => [item],
    listFiles: async () => new Map([[
      `${item.id}.mp4`,
      { id: 'file-morning', name: `${item.id}.mp4`, appProperties: {} },
    ]]),
    setProperties: async () => {},
    publishPlatform: async () => { publishCalls++; },
    notifyFn: async () => {},
  });

  assert.equal(result.status, 'waiting-for-video');
  assert.equal(publishCalls, 0);
});

test('does not republish Facebook when only Instagram needs a retry', async () => {
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
  assert.deepEqual(posts, ['facebook', 'instagram']);

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
  assert.deepEqual(posts, ['facebook', 'instagram', 'instagram']);
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
        facebookPostId: 'fb-old',
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
