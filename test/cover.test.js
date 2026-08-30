// Обкладинка для сітки профілю: мітка має вказувати на фрагмент із назвою
// об'єкта, а не на службові слова й не на перший кадр, де тексту ще немає.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coverTimestampMs } from '../src/captions.js';

const DUR = [4.2, 4.0, 4.0];

test('мітка потрапляє у фрагмент із якорем', () => {
  const ms = coverTimestampMs(['ЗАПОРОЗЬКА СІЧ НА ХОРТИЦІ — ЦЕ НЕ ЗОВСІМ ПРАВДА.'], DUR);
  // Фрагмент «ЗАПОРОЗЬКА СІЧ» триває 0–1,09 с; середина має бути всередині.
  assert.ok(ms > 300 && ms < 900, `очікували 300–900 мс, отримали ${ms}`);
});

test('мітка не збігається з першим кадром', () => {
  const ms = coverTimestampMs(['СВІТЯЗЬ — НАЙГЛИБШЕ ОЗЕРО УКРАЇНИ, І МІЛІЄ ВОНО ЧЕРЕЗ КОРДОН.'], DUR);
  assert.ok(ms > 0, 'нуль означав би той самий безтекстовий перший кадр');
});

test('службові слова на початку не потрапляють на обкладинку', () => {
  // Саме через це в сітці «Звідки ми» стояли обкладинки «ВСІЙ» і «А ЗГОДОМ»:
  // перший фрагмент складався з коротких службових слів. Мітка має зсунутися
  // до змістовного слова, але лишитися в межах зачину.
  const line = 'ВСІЙ КРАЇНІ ВІДОМЕ ЦЕ ПРІЗВИЩЕ, АЛЕ ЙОГО КОРІНЬ ІНШИЙ.';
  const ms = coverTimestampMs([line], DUR);
  assert.ok(ms > 900, `мітка ${ms} мс лишилася на службових словах`);
  assert.ok(ms < DUR[0] * 1000, `мітка ${ms} мс вийшла за перший слайд`);
});

test('якір на початку рядка з місця не зсувається', () => {
  // Зворотний бік того самого правила: коли зачин починається з власної
  // назви, шукати далі не треба — вона й має бути на обкладинці.
  const ms = coverTimestampMs(['ПОТЬОМКІНСЬКІ СХОДИ В ОДЕСІ ОБМАНЮЮТЬ КОЖНОГО.'], DUR);
  assert.ok(ms < 1200, `мітка ${ms} мс проскочила повз назву на початку`);
});

test('порожні дані не ламають публікацію', () => {
  assert.equal(coverTimestampMs([], []), null);
  assert.equal(coverTimestampMs(null, null), null);
  assert.equal(coverTimestampMs(['ЄДИНИЙ РЯДОК ТУТ'], []), null);
});

test('мітка лишається в межах першого слайда', () => {
  const ms = coverTimestampMs(['ОПТИМІСТИЧНА ПЕЧЕРА ДОСІ НЕ МАЄ ЗНАЙДЕНОГО КІНЦЯ.'], DUR);
  assert.ok(ms < DUR[0] * 1000, `мітка ${ms} мс вийшла за перший слайд`);
});

// --- Обкладинка YouTube ------------------------------------------------------
// Перша ж залита добірка лишилася без обкладинки: YouTube відповів «The
// provided image content is invalid». Причина в тому, що ChatGPT віддає PNG,
// мінідодаток кладе його на Drive під іменем .jpg, а заливка каже, що це JPEG.
// Тому картинку тепер завжди переганяємо самі.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeThumbnail, THUMB_MAX_BYTES } from '../src/preview.js';

const run = promisify(execFile);

async function haveFfmpeg() {
  try { await run('ffmpeg', ['-version']); return true; } catch { return false; }
}

test('PNG будь-якого розміру стає JPEG 1280×720 під лімітом YouTube', async (t) => {
  if (!await haveFfmpeg()) return t.skip('ffmpeg недоступний');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'thumb-'));
  try {
    const src = path.join(dir, 'src.png');
    // 16:9, але не той розмір, і саме PNG — як віддає генератор.
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1536x864:d=1',
      '-frames:v', '1', '-c:v', 'png', src]);

    const out = await normalizeThumbnail(src, path.join(dir, 'ready.jpg'));
    assert.ok(out.bytes <= THUMB_MAX_BYTES, `завелика: ${out.bytes}`);
    assert.equal((await stat(out.path)).size, out.bytes);

    const probe = await run('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_name,width,height', '-of', 'csv=p=0', out.path]);
    assert.equal(probe.stdout.trim(), 'mjpeg,1280,720');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('вертикальна картинка кадрується, а не розтягується', async (t) => {
  if (!await haveFfmpeg()) return t.skip('ffmpeg недоступний');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'thumb-'));
  try {
    const src = path.join(dir, 'tall.png');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:d=1',
      '-frames:v', '1', '-c:v', 'png', src]);
    const out = await normalizeThumbnail(src, path.join(dir, 'ready.jpg'));
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries',
      'stream=width,height', '-of', 'csv=p=0', out.path]);
    assert.equal(probe.stdout.trim(), '1280,720');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
