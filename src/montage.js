// Збірка вертикального слайдшоу 1080x1920 (9:16) з фотографій одним викликом ffmpeg.
import { execFile } from 'node:child_process';

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 25;
export const DEFAULT_SLIDE_SECONDS = 4;
export const FADE_SECONDS = 0.5;

// Приводить аргумент до масиву тривалостей слайдів (с). Число → рівні слайди
// по DEFAULT_SLIDE_SECONDS; масив → його ж (тривалість кожного слайда окремо,
// коли відео підлаштовується під озвучку).
function toDurations(slidesOrCount) {
  if (Array.isArray(slidesOrCount)) return slidesOrCount;
  return Array.from({ length: slidesOrCount }, () => DEFAULT_SLIDE_SECONDS);
}

// Загальна тривалість слайдшоу: сума тривалостей мінус перекриття xfade'ами.
export function slideshowDuration(slidesOrCount) {
  const d = toDurations(slidesOrCount);
  return d.reduce((a, b) => a + b, 0) - (d.length - 1) * FADE_SECONDS;
}

// Момент (с), коли кожен слайд починає з'являтися (= offset відповідного
// xfade). o[0]=0; o[i]=o[i-1]+d[i-1]-FADE. Це і час старту озвучки слайда.
export function slideOffsets(slidesOrCount) {
  const d = toDurations(slidesOrCount);
  const offsets = [0];
  for (let i = 1; i < d.length; i++) offsets.push(offsets[i - 1] + d[i - 1] - FADE_SECONDS);
  return offsets;
}

export function buildFilterComplex(slidesOrCount) {
  const durations = toDurations(slidesOrCount);
  const offsets = slideOffsets(durations);
  const count = durations.length;
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      // Нормалізація до строгих 1080x1920 без чорних смуг: масштаб по меншій
      // стороні + кроп по центру (важливий контент за промптом — у центральних 80%).
      `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${WIDTH}:${HEIGHT},setsar=1,` +
        // Ken Burns: повільний zoom-in до 1.08; тривалість слайда — своя.
        `zoompan=z='min(zoom+0.0008,1.08)':d=${Math.round(durations[i] * FPS)}:` +
        `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
        // Однакова часова база потрібна для xfade.
        `settb=AVTB[v${i}]`,
    );
  }
  let previous = 'v0';
  for (let i = 1; i < count; i++) {
    const output = i === count - 1 ? 'vout' : `x${i}`;
    parts.push(
      `[${previous}][v${i}]xfade=transition=fade:duration=${FADE_SECONDS}:offset=${offsets[i].toFixed(3)}[${output}]`,
    );
    previous = output;
  }
  return parts.join(';');
}

// slides — або кількість фото (рівні слайди), або масив тривалостей слайдів
// у секундах (коли відео підлаштовується під довжину озвучки кожного слайда).
export async function buildSlideshow(photoPaths, outputPath, slides = photoPaths.length) {
  if (photoPaths.length < 2) {
    throw new Error(`Для монтажу треба мінімум 2 фото, отримано ${photoPaths.length}`);
  }
  const args = ['-y'];
  for (const photoPath of photoPaths) args.push('-i', photoPath);
  args.push(
    '-filter_complex', buildFilterComplex(slides),
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-r', String(FPS),
    '-movflags', '+faststart',
    outputPath,
  );
  await runFfmpeg(args);
  return outputPath;
}

// Підкладає озвучку під готове відео; тиша в кінці, якщо аудіо коротше.
export async function mixAudio(videoPath, audioPath, outputPath) {
  await runFfmpeg([
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v',
    '-map', '1:a',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-af', 'apad',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ]);
  return outputPath;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        error.message = `ffmpeg завершився з помилкою: ${error.message.split('\n')[0]}`;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
