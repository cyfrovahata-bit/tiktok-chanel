import test from 'node:test';
import assert from 'node:assert/strict';
import { publishNow, runAutoPublishOnce } from '../src/autopublish.js';

process.env.ENABLE_IG = '1';
process.env.ENABLE_TIKTOK = '1';
process.env.ENABLE_YOUTUBE = '1';
process.env.ENABLE_FB = '1';
const item = { id: 'late', title: 'Late', description: 'Description', archive: 'archive', status: 'DONE' };
function setup(props = {}) {
  const file = { id: 'file', name: 'late.mp4', appProperties: props };
  const files = new Map([['late.mp4', file]]);
  const calls = [];
  return { files, calls, options: {
    now: new Date('2026-10-26T21:30:00Z'),
    listItems: async () => [item], listFiles: async () => files,
    setProperties: async (_, patch) => Object.assign(file.appProperties, patch),
    publishPlatform: async (platform) => {
      calls.push(platform); return { platform, status: 'published', id: `${platform}-id` };
    },
  } };
}
test('late manual publication skips existing IDs, intentional omissions and Facebook; retry is idempotent', async () => {
  const s = setup({ instagramPostId: 'existing', youtubeSkipped: 'compilation' });
  assert.equal((await publishNow('late', s.options)).status, 'published');
  assert.deepEqual(s.calls, ['tiktok']);
  assert.equal((await publishNow('late', s.options)).status, 'nothing-to-publish');
  assert.deepEqual(s.calls, ['tiktok']);
});
test('regenerated videos retain duplicate protection from marker', async () => {
  const s = setup();
  s.files.set('late.mp4.autopost.json', { appProperties: { instagramPostId: 'old' } });
  await publishNow('late', s.options);
  assert.deepEqual(s.calls, ['tiktok', 'youtube']);
});
test('partial failure retries only missing platforms', async () => {
  const s = setup();
  const publish = s.options.publishPlatform;
  s.options.publishPlatform = async (p) => p === 'tiktok' ? { platform: p, status: 'error', detail: 'failed' } : publish(p);
  assert.equal((await publishNow('late', s.options)).status, 'incomplete');
  s.calls.length = 0; s.options.publishPlatform = publish;
  await publishNow('late', s.options);
  assert.deepEqual(s.calls, ['tiktok']);
});
test('manual and scheduled runs cannot publish concurrently; lock releases after failure', async () => {
  const s = setup();
  let release;
  s.options.listItems = () => new Promise((resolve) => { release = resolve; });
  const pending = publishNow('late', s.options);
  await assert.rejects(publishNow('late', s.options), /вже триває/);
  assert.equal((await runAutoPublishOnce()).status, 'busy');
  release([]);
  await assert.rejects(pending, /не готовий/);
  s.options.listItems = async () => [item];
  assert.equal((await publishNow('late', s.options)).status, 'published');
});
