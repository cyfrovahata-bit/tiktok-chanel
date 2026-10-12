import test from 'node:test';
import assert from 'node:assert/strict';
import { queueCommentLikes, drainCommentLikes } from '../src/comment-likes.js';
import { checkPlatform } from '../src/comment-flow.js';
import { likeInstagram } from '../src/meta-comments.js';

const setup = () => ({ seen: {}, drafts: {} });
const opts = { sleepFn: async () => {}, persistFn: async () => {} };
test('likes include every foreign reply, including answered roots, but exclude own and imported history', async () => {
  const s = setup(); s.history = { startedAt: '2026-10-12T08:00:00Z', platforms: { fb: {} } };
  const ids = []; const a = { key: 'fb', like: async id => ids.push(id) };
  queueCommentLikes(s, a, { id: 'root', publishedAt: '2026-10-12T09:00:00Z', thread: [
    { id: 'old', publishedAt: '2026-10-11T09:00:00Z' },
    { id: 'ours', ours: true, publishedAt: '2026-10-12T10:00:00Z' },
    { id: 'one', publishedAt: '2026-10-12T11:00:00Z' },
    { id: 'two', publishedAt: '2026-10-12T12:00:00Z' },
  ] });
  await drainCommentLikes(s, a, opts);
  assert.deepEqual(ids, ['root', 'one', 'two']);
});
test('queued likes survive a failure and retry even when there are no reply candidates', async () => {
  const s = setup(); let fail = true; let calls = 0;
  const a = { key: 'fb', label: 'Facebook', fetch: async () => [], like: async () => { calls++; if (fail) throw new Error('network'); } };
  queueCommentLikes(s, a, { id: 'comment' });
  const options = { ...opts, state: s, notifyFn: async () => {}, chatId: 'owner' };
  await checkPlatform(a, options);
  assert.ok(s.likeQueue['fb:comment']);
  fail = false;
  await checkPlatform(a, options);
  assert.equal(s.liked['fb:comment'], 1);
  await checkPlatform(a, options);
  assert.equal(calls, 2);
});
test('model-skipped and previously seen comments still get a like exactly once', async () => {
  const s = setup(); const ids = [];
  const a = { key: 'ig', label: 'Instagram', link: () => '', fetch: async () => [{ id: 'c', text: 'Reply' }], like: async id => ids.push(id) };
  const options = { ...opts, state: s, autoReply: true, postIndex: [], chat: async () => 'ПРОПУСТИТИ: інша тема', notifyFn: async () => {}, chatId: 'owner' };
  await checkPlatform(a, options);
  await checkPlatform(a, options);
  assert.deepEqual(ids, ['c']);
});
test('missing Instagram scope notifies once, retains queue, and retries after token replacement', async () => {
  const s = setup(); let calls = 0; let reports = 0;
  const a = { key: 'ig', label: 'Instagram', like: async () => { calls++; if (calls === 1) throw new Error('Missing permission instagram_manage_engagement (code 200)'); } };
  queueCommentLikes(s, a, { id: 'c' });
  const o = { ...opts, token: 'old', notifyFn: async () => { reports++; } };
  await drainCommentLikes(s, a, o);
  await drainCommentLikes(s, a, o);
  assert.equal(reports, 1); assert.equal(calls, 1); assert.ok(s.likeQueue['ig:c']);
  await drainCommentLikes(s, a, { ...o, token: 'new' });
  assert.equal(s.liked['ig:c'], 1);
});
test('Instagram likes target the IG User edge with the actual comment ID', async () => {
  let call;
  await likeInstagram('reply-id', { token: 'test-token', igUserId: 'account-id', fetchImpl: async (url, request) => {
    call = { url: String(url), request }; return new Response('{"success":true}');
  } });
  assert.match(call.url, /\/account-id\/likes$/);
  assert.equal(call.request.method, 'POST');
  assert.equal(call.request.body.get('comment_id'), 'reply-id');
});

test('Instagram Authorization Error code 100 subcode 33 reports access failure and pauses only likes', async () => {
  const s = setup(); let message;
  const a = { key: 'ig', label: 'Instagram', like: async () => { throw new Error('Authorization Error (code 100, subcode 33)'); } };
  queueCommentLikes(s, a, { id: 'c' });
  await drainCommentLikes(s, a, { ...opts, notifyFn: async (_, text) => { message = text; } });
  assert.match(message, /instagram_manage_engagement/);
  assert.ok(s.likeBlocked.ig.until > Date.now());
  assert.ok(s.likeQueue['ig:c']);
  assert.equal(s.budget?.pausedUntil || 0, 0);
});
