import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { drive } from './drive.js';
import { promptFolderId } from './kyiv.js';

export const webhookMode = () => process.env.META_COMMENTS_MODE === 'webhook'
  && Boolean(process.env.META_APP_SECRET && process.env.META_WEBHOOK_VERIFY_TOKEN);
export function webhookStatus() {
  return { mode: webhookMode() ? 'webhook' : 'poll',
    verifyReady: Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN),
    signatureReady: Boolean(process.env.META_APP_SECRET) };
}
export function verifyChallenge(params, token = process.env.META_WEBHOOK_VERIFY_TOKEN) {
  return token && params.get('hub.mode') === 'subscribe' && params.get('hub.verify_token') === token
    ? params.get('hub.challenge') : null;
}
export function validSignature(raw, signature, secret = process.env.META_APP_SECRET) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/i.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
export function parseEvents(payload, config = process.env) {
  const platform = payload.object === 'page' ? 'fb' : payload.object === 'instagram' ? 'ig' : null;
  const account = platform === 'fb' ? config.META_PAGE_ID : config.META_IG_USER_ID;
  if (!platform || !account) return [];
  const events = [];
  for (const entry of payload.entry || []) {
    if (String(entry.id) !== String(account)) continue;
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (platform === 'fb' && (change.field !== 'feed' || v.item !== 'comment')) continue;
      if (platform === 'ig' && !['comments', 'live_comments'].includes(change.field)) continue;
      const postId = platform === 'fb' ? v.post_id : v.media?.id || v.media_id;
      const commentId = platform === 'fb' ? v.comment_id : v.id;
      if (!postId || !commentId) continue;
      const fingerprint = createHash('sha256').update(JSON.stringify([platform, entry.id, entry.time, change])).digest('hex');
      events.push({ platform, postId: String(postId), commentId: String(commentId), fingerprint });
    }
  }
  return events;
}

const FILE = 'meta-webhook-queue.json';
let chain = Promise.resolve();
export function queueLock(fn) {
  const result = chain.then(fn);
  chain = result.catch(() => {});
  return result;
}
async function readQueue() {
  const api = drive();
  const found = await api.files.list({ q: `'${promptFolderId()}' in parents and name = '${FILE}' and trashed = false`, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
  const id = found.data.files?.[0]?.id;
  if (!id) return { id: null, pending: {}, seen: {} };
  const r = await api.files.get({ fileId: id, alt: 'media', supportsAllDrives: true });
  const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  return { id, pending: data.pending || {}, seen: data.seen || {}, receivedAt: data.receivedAt };
}
async function saveQueue(q) {
  const { id, ...doc } = q;
  const media = { mimeType: 'application/json', body: JSON.stringify(doc) };
  if (id) await drive().files.update({ fileId: id, media, supportsAllDrives: true });
  else await drive().files.create({ requestBody: { name: FILE, parents: [promptFolderId()] }, media, fields: 'id', supportsAllDrives: true });
}
export function mergeEvents(q, events, now = Date.now()) {
  let accepted = 0;
  for (const e of events) {
    if (q.seen[e.fingerprint]) continue;
    const key = `${e.platform}:${e.postId}`;
    const prev = q.pending[key] || {};
    q.pending[key] = { platform: e.platform, postId: e.postId, revision: (prev.revision || 0) + 1 };
    q.seen[e.fingerprint] = now;
    accepted++;
  }
  // Коротка пам'ять доставок; повтори також стримує comments.json.
  q.seen = Object.fromEntries(Object.entries(q.seen).filter(([, at]) => now - at < 7 * 86400_000).slice(-20_000));
  q.receivedAt = new Date(now).toISOString();
  return accepted;
}
export async function acceptEvents(events) {
  if (!events.length) return 0;
  return queueLock(async () => { const q = await readQueue(); const n = mergeEvents(q, events); await saveQueue(q); return n; });
}
export function acknowledge(q, key, revision, result, now = Date.now()) {
  const current = q.pending[key];
  if (!current || current.revision !== revision) return;
  if (result && !result.error && !result.paused && !result.remaining && !result.throttled) delete q.pending[key];
  else { current.retryAt = now + 60_000; current.error = result?.error || 'Чекає наступної спроби'; }
}
let worker = null;
let draining = false;
let processPost = null;
export async function drainQueue() {
  if (!webhookMode() || !process.env.META_APP_SECRET || draining || !processPost) return;
  draining = true;
  try {
    const jobs = await queueLock(async () => Object.entries((await readQueue()).pending)
      .filter(([, j]) => !j.retryAt || j.retryAt <= Date.now()).slice(0, 5));
    for (const [key, job] of jobs) {
      let result;
      try { result = await processPost(job); }
      catch (error) { result = { error: error.message }; }
      await queueLock(async () => { const q = await readQueue(); acknowledge(q, key, job.revision, result); await saveQueue(q); });
      console.log('[meta:webhook] обробка', JSON.stringify({ platform: job.platform, postId: job.postId, result }));
    }
  } catch (error) { console.error('[meta:webhook]', error.message); }
  finally { draining = false; }
}
export function startWebhookWorker(fn) {
  processPost = fn;
  if (worker) return;
  worker = setInterval(() => drainQueue(), 30_000);
  drainQueue();
}

export async function handleWebhook(req, res, url, options = {}) {
  const status = webhookStatus();
  if (req.method === 'GET') {
    const challenge = verifyChallenge(url.searchParams);
    res.writeHead(challenge !== null ? 200 : 403, { 'content-type': 'text/plain' });
    res.end(challenge !== null ? challenge : 'Verification failed');
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  if (!status.signatureReady) { res.writeHead(503); res.end('Webhook app secret is not configured'); return; }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) { res.writeHead(413); res.end(); return; }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (!validSignature(raw, req.headers['x-hub-signature-256'])) { res.writeHead(403); res.end('Invalid signature'); return; }
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { res.writeHead(400); res.end('Invalid JSON'); return; }
  // Відповідаємо 200 лише після збереження черги, щоб рестарт не губив події.
  const accepted = await (options.accept || acceptEvents)(parseEvents(payload));
  console.log('[meta:webhook] прийнято', accepted, 'режим', status.mode);
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('EVENT_RECEIVED');
  if (webhookMode()) setTimeout(() => drainQueue(), 0);
}
