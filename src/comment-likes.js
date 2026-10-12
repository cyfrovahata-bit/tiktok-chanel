import { createHash } from 'node:crypto';
import { isHistorical } from './comment-history.js';
import { canAct, spend, pause, isRateLimit, nextPauseMs } from './comment-budget.js';

// Likes are independent of reply candidates and model decisions.
export function queueCommentLikes(state, adapter, snapshot) {
  if (!['fb', 'ig'].includes(adapter.key) || !adapter.like || process.env.COMMENTS_AUTO_LIKE === '0') return;
  state.likeQueue ||= {};
  const comments = [snapshot, ...(snapshot.thread || []).map(c => ({ ...c, postId: snapshot.postId, mediaId: snapshot.mediaId, permalink: snapshot.permalink }))];
  for (const c of comments) {
    if (!c.id || c.ours || isHistorical(state, adapter.key, c)) continue;
    const key = `${adapter.key}:${c.id}`;
    if (state.liked?.[key] || state.likeQueue[key]) continue;
    state.likeQueue[key] = { id: c.id, postId: c.postId, mediaId: c.mediaId, permalink: c.permalink, publishedAt: c.publishedAt };
  }
}

export async function drainCommentLikes(state, adapter, options = {}) {
  if (!['fb', 'ig'].includes(adapter.key) || !adapter.like || process.env.COMMENTS_AUTO_LIKE === '0') return {};
  const now = options.now ?? Date.now();
  const authStamp = createHash('sha256').update(String(options.token || process.env.META_PAGE_ACCESS_TOKEN || '') + ':' + String(options.igUserId || process.env.META_IG_USER_ID || '')).digest('hex');
  if (state.likeBlocked?.[adapter.key]?.authStamp === authStamp && (state.likeBlocked?.[adapter.key]?.until || 0) > now) return { likeBlocked: true };
  const persist = options.persistFn || (async () => {});
  const wait = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const entries = Object.entries(state.likeQueue || {}).filter(([key]) => key.startsWith(`${adapter.key}:`));
  let liked = 0;
  const limit = options.likeLimit ?? (Number(process.env.COMMENTS_LIKE_PER_RUN) || 15);
  for (const [key, comment] of entries) {
    if (state.liked?.[key]) { delete state.likeQueue[key]; continue; }
    if (liked >= limit || !canAct(state.budget, now)) break;
    // Also separates the first like from a reply just published by this pass.
    await wait(nextPauseMs());
    try {
      await adapter.like(comment.id, options);
      state.liked ||= {};
      state.liked[key] = 1;
      delete state.likeQueue[key];
      state.budget = spend(state.budget, now);
      liked++;
      await persist(state);
    } catch (error) {
      console.error(`[comments:${adapter.key}] лайк:`, error.message);
      if (isRateLimit(error.message)) state.budget = pause(state.budget, now);
      // Do not spend every pass retrying a missing scope. Replies keep running.
      if (/permission|not supported|unsupported|code (10|200)\b/i.test(error.message)) {
        state.likeBlocked ||= {};
        state.likeBlocked[adapter.key] = { until: now + 24 * 60 * 60 * 1000, error: error.message, authStamp };
        if (options.notifyFn) await options.notifyFn(options.chatId,
          `⚠️ ${adapter.label}: не вдалося поставити лайк. ${error.message}`
          + (adapter.key === 'ig' ? '\nДля Instagram перевір дозвіл instagram_manage_engagement у застосунку й токені.' : '')
          + '\nЛайки залишилися в черзі; відповіді працюють окремо.').catch(() => {});
      }
      await persist(state);
      break;
    }
  }
  const likesPending = Object.keys(state.likeQueue || {}).filter(key => key.startsWith(`${adapter.key}:`)).length;
  return { liked, likesPending, ...(likesPending && !canAct(state.budget, now) ? { throttled: true } : {}) };
}
