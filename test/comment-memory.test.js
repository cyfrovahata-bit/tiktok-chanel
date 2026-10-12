import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberThread, withThreadMemory, rememberReply } from '../src/comment-memory.js';
import { stateDoc, loadPostIndex, findPost } from '../src/comment-flow.js';
import { fetchFacebookComments, fetchInstagramComments } from '../src/meta-comments.js';

test('Meta memory survives serialization, merges by ID, isolates posts and platforms', () => {
  let state = { seen: {}, drafts: {} };
  const c = { postId: 'p', id: 'root', author: 'A', text: 'Питання', thread: [{ id: 'r', text: 'old', author: 'B', publishedAt: '2026-10-01' }] };
  rememberThread(state, 'fb', c);
  state = JSON.parse(JSON.stringify(stateDoc(state)));
  rememberThread(state, 'fb', { ...c, thread: [{ id: 'r', text: 'edited', author: 'B', publishedAt: '2026-10-01' }, { id: 'r2', text: 'new', publishedAt: '2026-10-02' }] });
  const result = withThreadMemory(state, 'fb', { ...c, thread: [] });
  assert.deepEqual(result.thread.map(r => r.text), ['edited', 'new']);
  assert.equal(withThreadMemory(state, 'ig', c).thread.length, 1);
  assert.equal(withThreadMemory(state, 'fb', { ...c, postId: 'other' }).thread.length, 1);
});

test('saved own reply suppresses old candidates but preserves a newer follow-up', () => {
  const state = {};
  const c = { mediaId: 'p', id: 'root', text: 'Question' };
  const key = rememberThread(state, 'ig', c);
  rememberReply(state, key, { id: 'ours' }, 'Answer');
  assert.equal(withThreadMemory(state, 'ig', c), null);
  const next = { ...c, id: 'new', parentId: 'root', parentText: 'Question', publishedAt: '2099-01-01', text: 'Follow-up' };
  rememberThread(state, 'ig', next);
  assert.equal(withThreadMemory(state, 'ig', next).threadAnswered, true);
});

test('sheet-only plot can be matched without an MP4', async () => {
  const index = await loadPostIndex({ listFiles: async () => new Map(), listItems: async () => [{ id: 'row', title: 'Історія старої фортеці', extra: 'ТЕКСТИ СЛАЙДІВ\n1. Сюжет із таблиці\n' }] });
  const post = findPost(index, 'fb', { postId: 'p', postText: 'Історія старої фортеці' });
  assert.equal(post.rowId, 'row');
  assert.deepEqual(post.script, ['Сюжет із таблиці']);
  assert.equal(post.bind, null);
});

for (const platform of ['fb', 'ig']) test(`${platform}: paginate roots and replies, capture already answered threads`, async () => {
  process.env.META_PAGE_ID = 'page'; process.env.META_IG_USER_ID = 'ig'; process.env.META_PAGE_ACCESS_TOKEN = 'token';
  const edge = platform === 'fb' ? 'comments' : 'replies';
  const root = { id: 'root', message: 'Question', text: 'Question', from: { id: 'user' }, [edge]: { data: [], paging: { next: 'ignored', cursors: { after: 'reply-cursor' } } } };
  const snapshots = [];
  const fetchImpl = async url => {
    const u = new URL(url); let data;
    if (u.pathname.endsWith(`/root/${edge}`)) data = { data: [{ id: 'own', message: 'Answer', text: 'Answer', from: { id: platform === 'fb' ? 'page' : 'ig' }, created_time: '2026-01-01', timestamp: '2026-01-01' }] };
    else if (u.pathname.endsWith('/post/comments')) data = { data: [{ id: 'second', message: 'Other', text: 'Other' }] };
    else data = { data: [{ id: 'post', comments: { data: [root], paging: { next: 'ignored', cursors: { after: 'root-cursor' } } } }] };
    return { ok: true, text: async () => JSON.stringify(data) };
  };
  const result = await (platform === 'fb' ? fetchFacebookComments : fetchInstagramComments)({ fetchImpl, onThread: c => snapshots.push(c) });
  assert.ok(!result.some(c => c.id === 'root'));
  assert.ok(result.some(c => c.id === 'second'));
  assert.equal(snapshots.find(c => c.id === 'root').thread[0].ours, true);
});

test('cached plot is reused across different roots without reading Sheet or Drive', async () => {
  const { checkPlatform } = await import('../src/comment-flow.js');
  const state = { seen: {}, drafts: {}, posts: { 'ig:post': { title: 'Старий замок', rowId: 'row', script: ['Відомий сюжет'], matchedBy: 'strong' } } };
  const adapter = { key: 'ig', label: 'Instagram', icon: '', link: () => '', fetch: async () => [{ id: 'new-root', mediaId: 'post', text: 'Коли його побудували?', author: 'A' }] };
  let prompt;
  await checkPlatform(adapter, { state, listFiles: async () => { throw new Error('Drive must not be read'); }, listItems: async () => { throw new Error('Sheet must not be read'); }, chat: async p => { prompt = p; return 'Уточнимо дату.'; }, notifyFn: async () => ({ message_id: 1 }), chatId: 'owner' });
  assert.match(prompt, /Відомий сюжет/);
  assert.match(prompt, /Старий замок/);
  assert.equal(state.seen['ig:new-root'], 'pending');
  assert.equal(JSON.parse(JSON.stringify(stateDoc(state))).posts['ig:post'].rowId, 'row');
});
