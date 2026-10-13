import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { previewInfo, savePreview } from './preview.js';

const run = promisify(execFile);
const active = new Map();
export const IMAGE_LAYOUTS = {
  video: { size: '1008x1792', width: 1080, height: 1920 },
  youtube: { size: '1088x1360', width: 1080, height: 1350 },
};

export function compilationImageKey(plan, kind) {
  return createHash('sha256').update(JSON.stringify([plan.date, plan.ids, plan.title, plan.theme, plan.thumbCaption, kind, plan.prompts?.[kind]])).digest('hex');
}

export function compilationImageMatchesPlan(plan, kind, info) {
  if (!info?.exists) return false;
  return info.generationKey === compilationImageKey(plan, kind)
    || (!info.generationKey && Date.parse(info.updatedAt) >= Date.parse(plan.plannedAt));
}

export async function generateCompilationImage(prompt, kind, options = {}) {
  const layout = IMAGE_LAYOUTS[kind];
  if (!layout) throw new Error('Невідомий вид зображення');
  const key = options.apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY не задано');
  const model = options.model || process.env.LONG_IMAGE_MODEL || 'gpt-image-2.5-flare';
  const response = await (options.fetchImpl || fetch)('https://api.openai.com/v1/images/generations', {
    method: 'POST', signal: AbortSignal.timeout(360000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, n: 1, size: layout.size,
      quality: process.env.LONG_IMAGE_QUALITY || 'medium', output_format: 'jpeg', output_compression: 90 }),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(`Генерація зображення: ${result.error?.message || `HTTP ${response.status}`}`);
  if (!result.data?.[0]?.b64_json) throw new Error('Генерація зображення повернула порожній файл');
  const raw = Buffer.from(result.data[0].b64_json, 'base64');
  const normalize = options.normalizeFn || normalizeCompilationImage;
  return { data: (await normalize(raw, kind)).toString('base64'), mimeType: 'image/jpeg', model,
    width: layout.width, height: layout.height };
}

export async function normalizeCompilationImage(buffer, kind) {
  const layout = IMAGE_LAYOUTS[kind];
  if (!layout) throw new Error('Невідомий вид зображення');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'long-image-'));
  try {
    const input = path.join(dir, 'input.jpg'); const output = path.join(dir, 'ready.jpg');
    await writeFile(input, buffer);
    await run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vf',
      `scale=${layout.width}:${layout.height}:force_original_aspect_ratio=increase,crop=${layout.width}:${layout.height}`,
      '-frames:v', '1', '-q:v', '3', output]);
    return await readFile(output);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// Save an attempt before billing the API. A restart never blindly repeats a
// running/failed attempt. A successful Drive upload can recover a lost plan write.
export async function ensureCompilationImages(plan, options = {}) {
  if (!plan?.prompts) throw new Error('Спочатку підбери сюжети добірки');
  const persist = options.persistFn || (async p => p);
  const info = options.infoFn || previewInfo;
  const save = options.saveFn || savePreview;
  const generate = options.generateFn || generateCompilationImage;
  const progress = options.onProgress || (() => {});
  const notify = options.notifyFn || (async () => {});
  let next = { ...plan, imageGeneration: { ...plan.imageGeneration } };
  for (const kind of options.kinds || ['video', 'youtube']) {
    if (!IMAGE_LAYOUTS[kind]) throw new Error('Невідомий вид зображення');
    const key = compilationImageKey(plan, kind);
    if (active.has(kind)) throw new Error('Генерація зображень уже триває');
    if (!options.force && next.imageGeneration[kind]?.key === key && next.imageGeneration[kind]?.state === 'done') continue;
    let done;
    const pending = new Promise(resolve => { done = resolve; });
    active.set(kind, pending);
    try {
      const existing = await info(kind);
      const attempt = next.imageGeneration[kind];
      const manual = existing?.exists && !existing.generationKey && Date.parse(existing.updatedAt) >= Date.parse(plan.plannedAt);
      if (!options.force && (existing?.generationKey === key || manual)) {
        next.imageGeneration[kind] = { key, state: 'done', source: manual ? 'manual' : 'api', fileId: existing.fileId, updatedAt: existing.updatedAt };
        next = await persist(next); continue;
      }
      if (!options.force && attempt?.key === key && ['running', 'error', 'done'].includes(attempt.state)) continue;
      next.imageGeneration[kind] = { key, state: 'running', startedAt: new Date().toISOString() };
      next = await persist(next);
      const label = kind === 'video' ? 'прев’ю 9:16 для відео' : 'обкладинку 4:5 для телефону';
      progress(`Малюю ${label}…`);
      try {
        const image = await generate(plan.prompts[kind], kind, options);
        const saved = await save({ kind, ...image, generationKey: key });
        next.imageGeneration[kind] = { key, state: 'done', source: 'api', model: image.model, width: image.width, height: image.height,
          fileId: saved.fileId, updatedAt: saved.updatedAt || new Date().toISOString() };
        next = await persist(next);
        progress(`Готово: ${label}`);
      } catch (error) {
        next.imageGeneration[kind] = { key, state: 'error', error: error.message, updatedAt: new Date().toISOString() };
        next = await persist(next);
        progress(error.message);
        await notify(`⚠️ Не вдалося намалювати ${label} до «${plan.title}»: ${error.message}\nПовторний запуск або ручне завантаження — у мінідодатку.`).catch(() => {});
      }
    } finally { active.delete(kind); done(); }
  }
  return next;
}
