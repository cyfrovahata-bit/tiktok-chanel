import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlatform, autoReplyEnabled, autoReport, replyTargets, sendReply } from '../src/comment-flow.js';
import { facebookAdapter } from '../src/meta-comments.js';

const comment = { id: 'p_c', postId: 'page_p', author: 'Viewer', text: 'Чому?', publishedAt: '2026-10-12T17:30:00Z' };
const state = () => ({ seen: {}, drafts: {}, threads: {} });
const makeAdapter = (reply) => ({ key: 'fb', label: 'Facebook', icon: '💬', fetch: async () => [comment], reply, link: facebookAdapter.link });
const settings = (s, notifyFn) => ({ state: s, autoReply: true, chatId: 'owner', postIndex: [], notifyFn, chat: async () => 'Саме так задумано.' });

test('autonomous Meta reply is published once and persisted before report, with deletion button', async () => {
  const s = state(); const order = []; const reports = [];
  const adapter = makeAdapter(async () => { order.push('reply'); return { id: 'p_reply' }; });
  const options = { ...settings(s, async (...args) => { order.push('report'); reports.push(args); }), persistFn: async () => { if (s.seen['fb:p_c'] === 'sent') order.push('persist'); } };
  const result = await checkPlatform(adapter, options);
  assert.equal(result.replied, 1); assert.equal(s.seen['fb:p_c'], 'sent');
  assert.ok(order.indexOf('persist') < order.indexOf('report'));
  assert.ok(reports[0][1].includes('reply_comment_id=reply'));
  assert.equal(reports[0][2].inline_keyboard[0][0].callback_data, 'c:d:fb:p_c');
  await checkPlatform(adapter, options);
  assert.equal(order.filter(x => x === 'reply').length, 1);
});
test('Telegram failure retains report and does not republish the successful answer', async () => {
  const s = state(); let replies = 0;
  const adapter = makeAdapter(async () => { replies++; return { id: 'p_reply' }; });
  await checkPlatform(adapter, settings(s, async () => { throw new Error('Telegram unavailable'); }));
  assert.equal(replies, 1); assert.equal(Object.keys(s.autoReportQueue).length, 1);
  let delivered = 0;
  await checkPlatform(adapter, settings(s, async () => { delivered++; }));
  assert.equal(replies, 1); assert.equal(delivered, 1); assert.equal(Object.keys(s.autoReportQueue).length, 0);
});
test('model skip supplies a reason without publishing or approval buttons', async () => {
  const s = state(); let replyCalls = 0; let report;
  const adapter = makeAdapter(async () => { replyCalls++; });
  await checkPlatform(adapter, { ...settings(s, async (_, text) => { report = text; }), chat: async () => 'ПРОПУСТИТИ: Особиста сварка між глядачами.' });
  assert.equal(replyCalls, 0); assert.match(report, /Особиста сварка/);
  assert.equal(s.seen['fb:p_c'], 'skipped-auto');
});
test('YouTube keeps approval mode and Facebook URLs identify the original comment and reply', () => {
  assert.equal(autoReplyEnabled('yt', { autoReply: true }), false);
  assert.equal(facebookAdapter.link(comment), 'https://www.facebook.com/page_p?comment_id=c');
  const report = autoReport(facebookAdapter, comment, { text: 'Answer', reply: { id: 'p_reply' } });
  assert.match(report, /comment_id=c&reply_comment_id=reply/);
});

test('Facebook uses the exact reply ID even when the stored draft points at the root', async () => {
  assert.deepEqual(replyTargets({ key: 'fb' }, 'REPLY', 'ROOT'), ['REPLY']);
  const tried = [];
  await assert.rejects(() => sendReply({ key: 'fb', reply: async id => {
    tried.push(id); throw new Error('Object does not exist');
  } }, replyTargets({ key: 'fb' }, 'REPLY', 'ROOT'), 'Text'));
  assert.deepEqual(tried, ['REPLY']);
});

test('own webhook comments never produce skip, pause, or fetch-error reports; viewer reports remain', async () => {
  const previous = process.env.META_PAGE_ID;
  process.env.META_PAGE_ID = 'page-owner';
  try {
    const own = { commentId: 'own', authorId: 'page-owner', postId: 'p' };
    const viewer = { commentId: 'viewer', authorId: 'viewer-account', postId: 'p' };
    for (const mode of ['normal', 'paused', 'error']) {
      const s = state(); const reports = [];
      if (mode === 'paused') s.budget = { pausedUntil: Date.now() + 60000 };
      const a = { ...makeAdapter(async () => {}), fetch: async () => { if (mode === 'error') throw new Error('network'); return []; } };
      const call = () => checkPlatform(a, { ...settings(s, async (_, text) => reports.push(text)), webhookComments: [own, viewer] });
      if (mode === 'error') await assert.rejects(call); else await call();
      assert.equal(reports.length, 1, mode);
      assert.match(reports[0], /comment_id=viewer/);
    }
  } finally { if (previous === undefined) delete process.env.META_PAGE_ID; else process.env.META_PAGE_ID = previous; }
});
test('saved Instagram own reply IDs are silent even when webhook has no author', async () => {
  const s = state(); s.autoReplies = { 'ig:viewer': { replyId: 'own-reply' } };
  const reports = [];
  await checkPlatform({ key: 'ig', label: 'Instagram', fetch: async () => [], link: () => '' }, {
    ...settings(s, async (_, text) => reports.push(text)), webhookComments: [{ commentId: 'own-reply', postId: 'p' }],
  });
  assert.equal(reports.length, 0);
});
