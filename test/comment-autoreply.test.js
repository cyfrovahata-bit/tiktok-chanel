import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlatform, autoReplyEnabled, autoReport } from '../src/comment-flow.js';
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
