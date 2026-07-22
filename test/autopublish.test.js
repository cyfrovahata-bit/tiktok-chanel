import test from 'node:test';
import assert from 'node:assert/strict';
import { currentPublishSlot, runAutoPublishOnce } from '../src/autopublish.js';

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
    { key: '2026-07-22-am', label: '10:00' },
  );
  assert.deepEqual(
    currentPublishSlot(new Date('2026-12-22T16:00:00Z')),
    { key: '2026-12-22-pm', label: '18:00' },
  );
  assert.equal(currentPublishSlot(new Date('2026-07-22T06:59:59Z')), null);
});

test('publishes newest ready video once and stores platform IDs outside Sheet', async () => {
  const items = [readyItem('OLD'), readyItem('NEW')];
  const files = new Map([
    ['OLD.mp4', { id: 'file-old', name: 'OLD.mp4', appProperties: {} }],
    ['NEW.mp4', { id: 'file-new', name: 'NEW.mp4', appProperties: {} }],
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
  assert.equal(first.itemId, 'NEW');
  assert.deepEqual(posts.map((post) => post.platform), ['facebook', 'instagram']);
  assert.equal(posts[0].payload.videoUrl, 'https://app.example.com/api/video/NEW');
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

test('does not republish Facebook when only Instagram needs a retry', async () => {
  const items = [readyItem('ONE')];
  const file = { id: 'file-one', name: 'ONE.mp4', appProperties: {} };
  const files = new Map([['ONE.mp4', file]]);
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
  const items = [readyItem('ONE')];
  const files = new Map([
    ['ONE.mp4', { id: 'new-video', name: 'ONE.mp4', appProperties: {} }],
    ['ONE.mp4.autopost.json', {
      id: 'marker',
      name: 'ONE.mp4.autopost.json',
      appProperties: {
        autoPostSlot: '2026-07-22-am',
        autoPostItemId: 'ONE',
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
