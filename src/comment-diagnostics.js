// Read-only diagnosis: never generates, sends, likes or alters comment state.
import { graphRequest } from './meta.js';
import { fetchFacebookComments } from './meta-comments.js';
import { readState } from './comment-flow.js';
import { withThreadMemory } from './comment-memory.js';
import { isHistorical } from './comment-history.js';

export async function diagnoseConfiguredComments() {
  const ids = String(process.env.META_COMMENT_DIAGNOSTICS || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
  if (!ids.length) return;
  const state = await readState();
  for (const id of ids) {
    const report = { id };
    try {
      const raw = await graphRequest(encodeURIComponent(id), {
        token: process.env.META_PAGE_ACCESS_TOKEN,
        params: { fields: 'id,message,created_time,from,comments.limit(25){id,from,created_time}' },
      });
      report.ownAuthor = raw.from?.id === process.env.META_PAGE_ID;
      report.hasText = Boolean(raw.message);
      report.createdAt = raw.created_time;
      report.ownReplies = (raw.comments?.data || []).filter(c => c.from?.id === process.env.META_PAGE_ID).length;
      report.seen = state.seen?.[`fb:${raw.id}`] || null;
      report.pending = Boolean(state.drafts?.[`fb:${raw.id}`]);
    } catch (error) { report.readError = error.message; }
    try {
      const snapshots = [];
      const candidates = await fetchFacebookComments({ postId: id, onThread: c => snapshots.push(c) });
      report.threads = snapshots.length;
      report.candidates = candidates.map(c => ({ id: c.id,
        seen: state.seen?.[`fb:${c.id}`] || null,
        historical: isHistorical(state, 'fb', c),
        memoryAnswered: !withThreadMemory(state, 'fb', c),
        createdAt: c.publishedAt,
      }));
      report.savedThreadRoots = Object.values(state.threads || {}).filter(t => snapshots.some(c => c.id === t.root?.id)).map(t => ({ id: t.root.id, ownReplies: Object.values(t.messages || {}).filter(m => m.ours).length }));
    } catch (error) { report.postError = error.message; }
    console.log('[comments:diagnostic]', JSON.stringify(report));
  }
}
