import test from 'node:test';
import assert from 'node:assert/strict';
import { publishFacebookReel, publishInstagramReel } from '../src/meta.js';

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Instagram: creates, waits for and publishes a Reel container', async () => {
  const calls = [];
  const responses = [
    reply({ id: 'container-1' }),
    reply({ status_code: 'IN_PROGRESS', status: 'Processing' }),
    reply({ status_code: 'FINISHED', status: 'Finished' }),
    reply({ id: 'instagram-media-1' }),
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return responses.shift();
  };

  const result = await publishInstagramReel({
    videoUrl: 'https://example.com/video.mp4',
    caption: 'Опис',
  }, {
    token: 'page-token',
    igUserId: '123',
    fetchImpl,
    sleep: async () => {},
    pollMs: 0,
    maxPolls: 3,
  });

  assert.deepEqual(result, { id: 'instagram-media-1', containerId: 'container-1' });
  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /\/123\/media$/);
  assert.equal(calls[0].options.body.get('media_type'), 'REELS');
  assert.equal(calls[0].options.body.get('video_url'), 'https://example.com/video.mp4');
  assert.match(calls[3].url, /\/123\/media_publish$/);
  assert.equal(calls[3].options.body.get('creation_id'), 'container-1');
});

test('Facebook: starts upload, transfers by public URL and publishes Reel', async () => {
  const calls = [];
  const responses = [
    reply({ video_id: 'fb-video-1', upload_url: 'https://rupload.facebook.test/upload' }),
    reply({ success: true }),
    reply({ success: true }),
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return responses.shift();
  };

  const result = await publishFacebookReel({
    videoUrl: 'https://example.com/video.mp4',
    description: 'Опис',
  }, {
    token: 'page-token',
    pageId: '456',
    fetchImpl,
  });

  assert.deepEqual(result, { id: 'fb-video-1', state: 'PUBLISHED' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.body.get('upload_phase'), 'start');
  assert.equal(calls[1].options.headers.Authorization, 'OAuth page-token');
  assert.equal(calls[1].options.headers.file_url, 'https://example.com/video.mp4');
  assert.equal(calls[2].options.body.get('upload_phase'), 'finish');
  assert.equal(calls[2].options.body.get('video_state'), 'PUBLISHED');
  assert.equal(calls[2].options.body.get('description'), 'Опис');
  assert.equal(calls[2].options.body.get('is_ai_generated'), 'true');
});

test('Facebook: ШІ-позначку можна вимкнути через META_AI_LABEL=0', async () => {
  const calls = [];
  const responses = [
    reply({ video_id: 'fb-video-2', upload_url: 'https://rupload.facebook.test/upload' }),
    reply({ success: true }),
    reply({ success: true }),
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return responses.shift();
  };

  const previous = process.env.META_AI_LABEL;
  process.env.META_AI_LABEL = '0';
  try {
    await publishFacebookReel(
      { videoUrl: 'https://example.com/video.mp4', description: 'Опис' },
      { token: 'page-token', pageId: '456', fetchImpl },
    );
  } finally {
    if (previous === undefined) delete process.env.META_AI_LABEL;
    else process.env.META_AI_LABEL = previous;
  }

  assert.equal(calls[2].options.body.has('is_ai_generated'), false);
});

test('Facebook: за наявності байтів файл ллється напряму, а не за посиланням', async () => {
  const calls = [];
  const responses = [
    reply({ video_id: 'fb-video-3', upload_url: 'https://rupload.facebook.test/upload' }),
    reply({ success: true }),
    reply({ success: true }),
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return responses.shift();
  };

  const bytes = Buffer.from('відео-байти');
  await publishFacebookReel(
    { videoUrl: 'https://example.com/video.mp4', videoBuffer: bytes, description: 'Опис' },
    { token: 'page-token', pageId: '456', fetchImpl },
  );

  const upload = calls[1];
  assert.equal(upload.options.headers.file_url, undefined, 'посилання не передаємо');
  assert.equal(upload.options.headers.offset, '0');
  assert.equal(upload.options.headers.file_size, String(bytes.length));
  assert.equal(upload.options.headers['content-type'], 'application/octet-stream');
  assert.ok(Buffer.isBuffer(upload.options.body));
  assert.equal(upload.options.body.toString(), 'відео-байти');
});

test('Facebook: META_UPLOAD_MODE=url повертає завантаження за посиланням', async () => {
  const calls = [];
  const responses = [
    reply({ video_id: 'fb-video-4', upload_url: 'https://rupload.facebook.test/upload' }),
    reply({ success: true }),
    reply({ success: true }),
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return responses.shift();
  };

  const previous = process.env.META_UPLOAD_MODE;
  process.env.META_UPLOAD_MODE = 'url';
  try {
    await publishFacebookReel(
      { videoUrl: 'https://example.com/video.mp4', videoBuffer: Buffer.from('x'), description: '' },
      { token: 'page-token', pageId: '456', fetchImpl },
    );
  } finally {
    if (previous === undefined) delete process.env.META_UPLOAD_MODE;
    else process.env.META_UPLOAD_MODE = previous;
  }

  assert.equal(calls[1].options.headers.file_url, 'https://example.com/video.mp4');
  assert.equal(calls[1].options.headers.offset, undefined);
});

test('Facebook: FB_REEL_STATE=DRAFT кладе ролик у чернетки', async () => {
  const calls = [];
  const responses = [
    reply({ video_id: 'fb-video-5', upload_url: 'https://rupload.facebook.test/upload' }),
    reply({ success: true }),
    reply({ success: true }),
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return responses.shift();
  };

  const previous = process.env.FB_REEL_STATE;
  process.env.FB_REEL_STATE = 'DRAFT';
  let result;
  try {
    result = await publishFacebookReel(
      { videoUrl: 'https://example.com/video.mp4', description: 'Опис' },
      { token: 'page-token', pageId: '456', fetchImpl },
    );
  } finally {
    if (previous === undefined) delete process.env.FB_REEL_STATE;
    else process.env.FB_REEL_STATE = previous;
  }

  assert.equal(calls[2].options.body.get('video_state'), 'DRAFT');
  assert.equal(result.state, 'DRAFT');
});

test('Meta errors include API code', async () => {
  const fetchImpl = async () => reply({
    error: { message: 'Invalid token', code: 190, error_subcode: 463 },
  }, 400);

  await assert.rejects(
    publishFacebookReel({
      videoUrl: 'https://example.com/video.mp4',
      description: '',
    }, { token: 'bad', pageId: '456', fetchImpl }),
    /Invalid token \(code 190, subcode 463\)/,
  );
});

test('Instagram Reel декларується як згенерований ШІ', async () => {
  // POST-параметри йдуть у тілі запиту, а не в URL.
  const bodies = [];
  const responses = [
    { id: 'container-1' },
    { status_code: 'FINISHED' },
    { id: 'reel-1' },
  ];
  const fetchImpl = async (_url, options) => {
    bodies.push(String(options?.body ?? ''));
    return { ok: true, status: 200, text: async () => JSON.stringify(responses.shift()) };
  };
  await publishInstagramReel(
    { videoUrl: 'https://app.example.com/api/video/X', caption: 'опис' },
    { token: 't', igUserId: '1', fetchImpl, sleep: async () => {} },
  );
  assert.match(bodies[0], /is_ai_generated=true/, 'контейнер має нести самодекларацію ШІ');
});
