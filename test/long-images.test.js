import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureCompilationImages, compilationImageKey, generateCompilationImage, IMAGE_LAYOUTS, normalizeCompilationImage, compilationImageMatchesPlan } from '../src/long-images.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const plan = () => ({ date: '2026-10-13', ids: ['a', 'b'], title: 'Інша Україна', plannedAt: '2026-10-13T05:00:00Z', prompts: { video: 'vertical video prompt', youtube: 'phone cover prompt' } });
const image = { data: 'fake', mimeType: 'image/jpeg', model: 'test', width: 1080, height: 1920 };
test('attempts persist before image generation, survive restart, and completed images are not charged again', async () => {
  let saved; const order = [];
  const options = { infoFn: async () => ({ exists: false }), persistFn: async p => { saved = structuredClone(p); order.push('persist'); return p; },
    generateFn: async () => { assert.equal(order.at(-1), 'persist'); order.push('generate'); return image; },
    saveFn: async () => ({ fileId: 'file-id' }) };
  await ensureCompilationImages(plan(), options);
  assert.equal(order.filter(x => x === 'generate').length, 2);
  await ensureCompilationImages(saved, options);
  assert.equal(order.filter(x => x === 'generate').length, 2);
});
test('failed automatic generation needs an explicit retry and does not overwrite the saved preview', async () => {
  let saved; let calls = 0; let uploads = 0; let notified = 0;
  const options = { kinds: ['video'], infoFn: async () => ({ exists: false }), persistFn: async p => { saved = structuredClone(p); return p; },
    generateFn: async () => { calls++; throw new Error('quota'); }, saveFn: async () => { uploads++; }, notifyFn: async () => { notified++; } };
  await ensureCompilationImages(plan(), options);
  await ensureCompilationImages(saved, options);
  assert.equal(calls, 1); assert.equal(uploads, 0); assert.equal(notified, 1);
  await ensureCompilationImages(saved, { ...options, force: true });
  assert.equal(calls, 2);
});
test('a Drive image recovers a running attempt after restart without another API call', async () => {
  const p = plan(); const key = compilationImageKey(p, 'video');
  p.imageGeneration = { video: { key, state: 'running' } };
  const result = await ensureCompilationImages(p, { kinds: ['video'], infoFn: async () => ({ exists: true, generationKey: key }),
    generateFn: async () => { throw new Error('must not bill'); } });
  assert.equal(result.imageGeneration.video.state, 'done');
});
test('manual upload after plan creation is preserved; a changed topic produces a new cache key', async () => {
  const p = plan(); const result = await ensureCompilationImages(p, { kinds: ['video'],
    infoFn: async () => ({ exists: true, updatedAt: '2026-10-13T06:00:00Z' }), generateFn: async () => { throw new Error('must not bill'); } });
  assert.equal(result.imageGeneration.video.source, 'manual');
  assert.notEqual(compilationImageKey(p, 'video'), compilationImageKey({ ...p, title: 'Нова тема' }, 'video'));
});
test('image API receives the specific prompt and exact portrait aspect ratios in one JPEG request', async () => {
  for (const kind of ['video', 'youtube']) {
    let request;
    await generateCompilationImage('specific topic', kind, { apiKey: 'test', normalizeFn: async b => b, fetchImpl: async (_, options) => {
      request = JSON.parse(options.body); return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    } });
    assert.equal(request.prompt, 'specific topic'); assert.equal(request.size, IMAGE_LAYOUTS[kind].size);
    assert.equal(request.n, 1); assert.equal(request.output_format, 'jpeg');
    assert.equal(request.response_format, undefined);
  }
});
test('normalization creates real JPEGs at the mobile dimensions', async () => {
  const run = promisify(execFile); const dir = await mkdtemp(path.join(os.tmpdir(), 'long-image-test-'));
  try {
    const ppm = Buffer.concat([Buffer.from('P6\n2 2\n255\n'), Buffer.alloc(12, 150)]);
    for (const kind of ['video', 'youtube']) {
      const jpeg = await normalizeCompilationImage(ppm, kind);
      assert.equal(jpeg[0], 255); assert.equal(jpeg[1], 216);
      const file = path.join(dir, `${kind}.jpg`); await writeFile(file, jpeg);
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
      assert.equal(stdout.trim(), `${IMAGE_LAYOUTS[kind].width},${IMAGE_LAYOUTS[kind].height}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('images for yesterday or a different compilation cannot silently become the current cover', () => {
  const p = plan();
  assert.equal(compilationImageMatchesPlan(p, 'video', { exists: true, generationKey: 'other-plan' }), false);
  assert.equal(compilationImageMatchesPlan(p, 'video', { exists: true, updatedAt: '2026-10-12T06:00:00Z' }), false);
  assert.equal(compilationImageMatchesPlan(p, 'video', { exists: true, generationKey: compilationImageKey(p, 'video') }), true);
  assert.equal(compilationImageMatchesPlan(p, 'video', { exists: true, updatedAt: '2026-10-13T06:00:00Z' }), true);
});
