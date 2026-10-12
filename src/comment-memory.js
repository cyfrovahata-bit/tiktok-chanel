// Історія Meta-гілок у comments.json на Drive; ключ включає платформу й допис.
export function threadKey(platform, comment) {
  const post = comment.postId || comment.mediaId;
  const root = comment.parentId || comment.id;
  return ['fb', 'ig'].includes(platform) && post && root ? `${platform}:${post}:${root}` : null;
}

export function rememberThread(state, platform, comment) {
  const key = threadKey(platform, comment);
  if (!key) return null;
  state.threads ||= {};
  const entry = state.threads[key] ||= { root: {}, messages: {} };
  entry.root = { ...entry.root, id: comment.parentId || comment.id,
    author: comment.parentAuthor || comment.author,
    text: comment.parentId ? comment.parentText : comment.text };
  for (const r of comment.thread || []) {
    if (r.id) entry.messages[r.id] = { ...entry.messages[r.id], ...r };
  }
  if (comment.parentId && comment.id) entry.messages[comment.id] = {
    ...entry.messages[comment.id], id: comment.id, author: comment.author,
    text: comment.text, ours: false, publishedAt: comment.publishedAt || '',
  };
  entry.updatedAt = new Date().toISOString();
  return key;
}

export function withThreadMemory(state, platform, comment) {
  const entry = state.threads?.[threadKey(platform, comment)];
  if (!entry) return comment;
  const thread = Object.values(entry.messages).sort((a, b) =>
    (Date.parse(a.publishedAt) || 0) - (Date.parse(b.publishedAt) || 0));
  const lastOurs = thread.filter(r => r.ours).at(-1);
  // Власник уже відповів, навіть якщо відповідь випала з поточного пакета API.
  if (lastOurs && (!comment.parentId ||
      (Date.parse(comment.publishedAt) || 0) <= (Date.parse(lastOurs.publishedAt) || 0))) return null;
  return { ...comment, thread, threadAnswered: Boolean(lastOurs) || comment.threadAnswered };
}

export function rememberReply(state, key, reply, text) {
  const entry = state.threads?.[key];
  if (!entry) return;
  const id = reply?.id || `local:${Date.now()}`;
  entry.messages[id] = { id, text, author: 'Канал', ours: true, publishedAt: new Date().toISOString() };
}
