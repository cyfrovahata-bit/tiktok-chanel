import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { validSignature, verifyChallenge, parseEvents, mergeEvents, acknowledge, handleWebhook } from '../src/meta-webhook.js';
import { fetchFacebookComments, fetchInstagramComments } from '../src/meta-comments.js';

const config = { META_PAGE_ID: 'page', META_IG_USER_ID: 'ig' };
const fb = { object: 'page', entry: [{ id: 'page', time: 1, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', post_id: 'old-post', comment_id: 'c' } }] }] };
const sign = body => 'sha256=' + createHmac('sha256', 'secret').update(body).digest('hex');
test('verification needs matching token and mode; signature validates exact raw bytes', () => {
  assert.equal(verifyChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=ok&hub.challenge=123'), 'ok'), '123');
  assert.equal(verifyChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=wrong'), 'ok'), null);
  assert.equal(validSignature(Buffer.from('{}'), sign('{}'), 'secret'), true);
  assert.equal(validSignature(Buffer.from('{ }'), sign('{}'), 'secret'), false);
  assert.equal(validSignature(Buffer.from('{}'), 'sha256=bad', 'secret'), false);
  assert.equal(validSignature(Buffer.from('{}'), sign('{}'), ''), false);
});
test('only comments for configured accounts are queued, including any old post', () => {
  assert.equal(parseEvents(fb, config)[0].postId, 'old-post');
  assert.deepEqual(parseEvents(fb, { ...config, META_PAGE_ID: 'other' }), []);
  const ig = { object: 'instagram', entry: [{ id: 'ig', changes: [{ field: 'comments', value: { id: 'c', media: { id: 'old-media' } } }, { field: 'messages', value: { id: 'ignore' } }] }] };
  assert.equal(parseEvents(ig, config).length, 1);
});
test('duplicate events survive restart and a newer revision cannot be erased by an old job', () => {
  let q = { pending: {}, seen: {} };
  const events = parseEvents(fb, config);
  assert.equal(mergeEvents(q, events, 100), 1);
  q = JSON.parse(JSON.stringify(q));
  assert.equal(mergeEvents(q, events, 200), 0);
  mergeEvents(q, [{ ...events[0], fingerprint: 'new' }], 300);
  acknowledge(q, 'fb:old-post', 1, {});
  assert.equal(q.pending['fb:old-post'].revision, 2);
  acknowledge(q, 'fb:old-post', 2, { remaining: 1 }, 400);
  assert.ok(q.pending['fb:old-post'].retryAt);
  acknowledge(q, 'fb:old-post', 2, {});
  assert.equal(q.pending['fb:old-post'], undefined);
});
test('poll mode stores signed events but does not process them; unsigned requests rejected', async () => {
  process.env.META_APP_SECRET = 'secret'; process.env.META_PAGE_ID = 'page'; process.env.META_COMMENTS_MODE = 'poll';
  let accepted = 0;
  const raw = JSON.stringify(fb);
  const request = signature => Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST', headers: { 'x-hub-signature-256': signature } });
  const response = () => ({ writeHead(code) { this.code = code; }, end(body) { this.body = body; } });
  const res = response();
  await handleWebhook(request(sign(raw)), res, new URL('https://example/webhooks/meta'), { accept: async e => { accepted += e.length; return e.length; } });
  assert.equal(res.code, 200); assert.equal(accepted, 1);
  const bad = response();
  await handleWebhook(request('bad'), bad, new URL('https://example/webhooks/meta'), { accept: async () => { throw new Error('must not store'); } });
  assert.equal(bad.code, 403);
});
for (const platform of ['fb', 'ig']) test(`${platform}: fetch a webhook post directly without scanning latest posts`, async () => {
  process.env.META_PAGE_ID = 'page'; process.env.META_IG_USER_ID = 'ig'; process.env.META_PAGE_ACCESS_TOKEN = 'token';
  const paths = [];
  const result = await (platform === 'fb' ? fetchFacebookComments : fetchInstagramComments)({ postId: 'old-post', fetchImpl: async url => {
    paths.push(new URL(url).pathname);
    return { ok: true, text: async () => JSON.stringify({ id: 'old-post', comments: { data: [{ id: 'c', text: 'Question', message: 'Question', timestamp: '2026-10-12', created_time: '2026-10-12' }] } }) };
  } });
  assert.equal(paths.length, 1); assert.ok(paths[0].endsWith('/old-post'));
  assert.equal(result[0].id, 'c');
});
