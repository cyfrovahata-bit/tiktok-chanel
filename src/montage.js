// Збірка вертикального слайдшоу 1080x1920 (9:16) з фотографій одним викликом ffmpeg.
import { execFile } from 'node:child_process';

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 25;
const SLIDE_SECONDS = 4;
const FADE_SECONDS = 0.5;

// Маскот (assets/mascot.png) накладається внизу зліва на 30% висоти кадру.
// Фон малюнка — суцільний майже чорний (#00000E); colorkey прибирає його
// без окремого інструменту для видалення фону.
const MASCOT_HEIGHT = Math.round(HEIGHT * 0.3);
const MASCOT_MARGIN = 40;
const MASCOT_BG_COLOR = '0x00000E';
const MASCOT_BG_SIMILARITY = 0.15;
const MASCOT_BG_BLEND = 0.05;
// «Дихання» + легкий підскок — щоб маскот виглядав живим без ліпсінку.
const MASCOT_PULSE_PERIOD = 1.4;
const MASCOT_PULSE_AMPLITUDE = 8;
const MASCOT_BOB_AMPLITUDE = 6;

export function buildFilterComplex(count) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      // Нормалізація до строгих 1080x1920 без чорних смуг: масштаб по меншій
      // стороні + кроп по центру (важливий контент за промптом — у центральних 80%).
      `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${WIDTH}:${HEIGHT},setsar=1,` +
        // Ken Burns: повільний zoom-in до 1.08 за 4 с (100 кадрів при 25 fps).
        `zoompan=z='min(zoom+0.0008,1.08)':d=${SLIDE_SECONDS * FPS}:` +
        `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
        // Однакова часова база потрібна для xfade.
        `settb=AVTB[v${i}]`,
    );
  }
  let previous = 'v0';
  for (let i = 1; i < count; i++) {
    const output = i === count - 1 ? 'vout' : `x${i}`;
    const offset = (SLIDE_SECONDS - FADE_SECONDS) * i; // 3.5, 7.0, 10.5, 14.0, 17.5
    parts.push(
      `[${previous}][v${i}]xfade=transition=fade:duration=${FADE_SECONDS}:offset=${offset}[${output}]`,
    );
    previous = output;
  }
  return parts.join(';');
}

export async function buildSlideshow(photoPaths, outputPath) {
  if (photoPaths.length < 2) {
    throw new Error(`Для монтажу треба мінімум 2 фото, отримано ${photoPaths.length}`);
  }
  const args = ['-y'];
  for (const photoPath of photoPaths) args.push('-i', photoPath);
  args.push(
    '-filter_complex', buildFilterComplex(photoPaths.length),
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

// Накладає маскота внизу зліва (30% висоти кадру), прибираючи його суцільний
// фон через colorkey. Легка пульсація розміру й підскок — щоб не був статичною
// наліпкою поверх відео.
export async function overlayMascot(videoPath, mascotPath, outputPath) {
  const size = `${MASCOT_HEIGHT}+${MASCOT_PULSE_AMPLITUDE}*sin(2*PI*t/${MASCOT_PULSE_PERIOD})`;
  const y = `main_h-overlay_h-${MASCOT_MARGIN}+${MASCOT_BOB_AMPLITUDE}*sin(2*PI*t/${MASCOT_PULSE_PERIOD}+1)`;
  const filter =
    `[1:v]colorkey=${MASCOT_BG_COLOR}:${MASCOT_BG_SIMILARITY}:${MASCOT_BG_BLEND},` +
    `scale=w='${size}':h='${size}':eval=frame[mascot];` +
    `[0:v][mascot]overlay=x=${MASCOT_MARGIN}:y='${y}':format=auto[vout]`;
  await runFfmpeg([
    '-y',
    '-i', videoPath,
    '-i', mascotPath,
    '-filter_complex', filter,
    '-map', '[vout]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-r', String(FPS),
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ]);
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
