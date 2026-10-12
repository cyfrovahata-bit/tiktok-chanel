import { rememberThread } from './comment-memory.js';

export function ensureHistory(state, platforms, now = new Date().toISOString()) {
  if (state.history) return state.history;
  state.history = { startedAt: now, platforms: {} };
  for (const adapter of platforms) {
    if (adapter.history && (!adapter.enabled || adapter.enabled())) {
      state.history.platforms[adapter.key] = { posts: 0, threads: 0, after: null, done: false };
    }
  }
  return state.history;
}

export function isHistorical(state, platform, comment) {
  if (!state.history?.platforms?.[platform]) return false;
  const at = Date.parse(comment.publishedAt || '');
  // Дату не дали — архівуємо без дій, а не відповідаємо навмання.
  return !Number.isFinite(at) || at <= Date.parse(state.history.startedAt);
}

export async function collectHistoryStep(state, adapters, options = {}) {
  const history = ensureHistory(state, adapters, options.startedAt);
  const now = options.now ?? Date.now();
  const result = [];
  for (const adapter of adapters) {
    const progress = history.platforms[adapter.key];
    if (!progress || progress.done || !adapter.history || (adapter.enabled && !adapter.enabled())) continue;
    if ((Date.parse(progress.retryAt || '') || 0) > now) continue;
    try {
      const page = await adapter.history({ ...options, after: progress.after });
      for (const comment of page.threads) {
        rememberThread(state, adapter.key, comment);
        options.rememberPost?.(adapter.key, comment);
      }
      if (page.next && page.next === progress.after) throw new Error('Meta повторив курсор сторінки');
      progress.posts += page.count;
      progress.threads += page.threads.length;
      progress.after = page.next;
      progress.done = !page.next;
      progress.updatedAt = new Date(now).toISOString();
      delete progress.error; delete progress.retryAt;
    } catch (error) {
      progress.error = error.message;
      progress.retryAt = new Date(now + 15 * 60 * 1000).toISOString();
    }
    result.push({ platform: adapter.key, ...progress });
  }
  if (Object.values(history.platforms).every(p => p.done)) history.completedAt ||= new Date(now).toISOString();
  return result;
}
