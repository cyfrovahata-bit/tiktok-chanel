// Позначка ШІ й вибір режиму — те, що не можна зламати непомітно:
// помилка тут або знімає декларацію ШІ, або відправляє ролик не туди.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishTikTokVideo } from '../src/tiktok.js';

process.env.TIKTOK_CLIENT_KEY = 'key';
process.env.TIKTOK_CLIENT_SECRET = 'secret';

// Ловить усі запити й повертає заготовлені відповіді TikTok.
function stubFetch(calls) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, body: options.body });
    const reply = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (href.includes('/creator_info/query/')) {
      return reply({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] } });
    }
    if (href.includes('/video/init/') || href.includes('/inbox/video/init/')) {
      return reply({ data: { publish_id: 'pub-1', upload_url: 'https://upload.example/x' } });
    }
    if (href.includes('/status/fetch/')) {
      return reply({ data: { status: href.includes('x') ? 'PUBLISH_COMPLETE' : 'PUBLISH_COMPLETE' } });
    }
    return { ok: true, status: 200, text: async () => '{}' }; // PUT завантаження
  };
  return () => { globalThis.fetch = original; };
}

test('пряма публікація несе позначку ШІ та публічну приватність', async () => {
  const calls = [];
  const restore = stubFetch(calls);
  try {
    const out = await publishTikTokVideo(
      { videoBuffer: Buffer.from('video-bytes'), title: 'Тема' },
      { tokens: { accessToken: 'a', scope: 'video.publish,video.upload' }, sleepFn: async () => {} },
    );
    assert.equal(out.mode, 'direct');
    assert.equal(out.privacy, 'PUBLIC_TO_EVERYONE');
    const init = calls.find((c) => c.url.includes('/post/publish/video/init/'));
    const body = JSON.parse(init.body);
    assert.equal(body.post_info.is_aigc, true, 'позначка ШІ обовʼязкова');
    assert.equal(body.post_info.privacy_level, 'PUBLIC_TO_EVERYONE');
    assert.equal(body.source_info.source, 'FILE_UPLOAD');
    assert.equal(body.source_info.total_chunk_count, 1);
  } finally { restore(); }
});

test('без video.publish ролик іде в чернетки, а не падає', async () => {
  const calls = [];
  const restore = stubFetch(calls);
  try {
    const out = await publishTikTokVideo(
      { videoBuffer: Buffer.from('video-bytes'), title: 'Тема' },
      { tokens: { accessToken: 'a', scope: 'video.upload' }, sleepFn: async () => {} },
    );
    assert.equal(out.mode, 'inbox');
    assert.ok(calls.some((c) => c.url.includes('/inbox/video/init/')));
    assert.ok(!calls.some((c) => c.url.includes('/creator_info/query/')), 'чернеткам creator_info не потрібен');
  } finally { restore(); }
});

test('TIKTOK_AI_LABEL=0 знімає позначку явно', async () => {
  const calls = [];
  const restore = stubFetch(calls);
  process.env.TIKTOK_AI_LABEL = '0';
  try {
    await publishTikTokVideo(
      { videoBuffer: Buffer.from('v'), title: 'Т' },
      { tokens: { accessToken: 'a', scope: 'video.publish' }, sleepFn: async () => {} },
    );
    const init = calls.find((c) => c.url.includes('/post/publish/video/init/'));
    assert.equal(JSON.parse(init.body).post_info.is_aigc, false);
  } finally { restore(); delete process.env.TIKTOK_AI_LABEL; }
});
