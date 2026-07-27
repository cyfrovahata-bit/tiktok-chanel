// Збірка вертикального слайдшоу 1080x1920 (9:16) з фотографій одним викликом ffmpeg.
// Якщо передано підписи слайдів — другим проходом «випікаємо» ASS-субтитри
// (караоке-накопичення тексту синхронно з озвучкою).
import { execFile } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildAss } from './captions.js';

// Тека з бандленим шрифтом (Oswald Bold, підтримує українську кирилицю).
const FONTS_DIR = fileURLToPath(new URL('../assets/fonts', import.meta.url));

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 25;
// Meta вимагає для Reels closed GOP довжиною 2–5 секунд. За замовчуванням x264
// ставив ключовий кадр раз на ~10 с — на статичних кадрах із повільним zoompan
// детектор зміни сцени просто не спрацьовував.
const GOP_ARGS = ['-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-sc_threshold', '0', '-flags', '+cgop'];

// Звук за вимогами Meta до Reels: AAC-LC, 48 кГц, стерео, від 128 кбіт/с.
//
// Ціль 192k, а не 128k: -b:a задає ціль, а не гарантію, і на мовленні з паузами
// AAC витрачає помітно менше — при цілі 128k реальний середній вийшов 106k,
// тобто нижче вимоги. При 192k виходить ~163k, із запасом.
//
// Моно→стерео робимо через pan, а не -ac 2: ffmpeg при -ac 2 ділить потужність
// між каналами і глушить доріжку рівно на 3 дБ. pan дублює канал як є.
// (aresample=rematrix_volume=1 не допомагає — перевірено, ті самі -3 дБ.)
const TO_STEREO = 'pan=stereo|c0=c0|c1=c0';
const REELS_AUDIO_ARGS = ['-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-b:a', '192k'];
export const DEFAULT_SLIDE_SECONDS = 4;
export const FADE_SECONDS = 0.5;
// J-cut: озвучка наступного слайда починається на стільки раніше за зміну
// кадру (природніші переходи, без пауз). Спільна константа для tts і субтитрів.
export const JCUT_SECONDS = 0.2;

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
    // Ken Burns: чергуємо напрямок між сусідніми слайдами, ~5% (у межах 3–6%),
    // завжди zoom>=1.0 — тож жодних чорних країв. Текст накладаємо окремим
    // проходом, тож він НЕ рухається разом із картинкою.
    // Рух ЛІНІЙНИЙ на ВСЮ тривалість слайда (z = f(номер кадру on)), тож кадр
    // рухається до самого кінця — жодних статичних «хвостів» на довгих слайдах.
    const frames = Math.round(durations[i] * FPS);
    const span = Math.max(frames - 1, 1);
    const zoom = i % 2 === 0
      ? `z='1+0.05*on/${span}'`        // наближення 1.00→1.05 за весь слайд
      : `z='1.05-0.05*on/${span}'`;    // віддалення 1.05→1.00 за весь слайд
    parts.push(
      // Нормалізація до строгих 1080x1920 без чорних смуг: масштаб по меншій
      // стороні + кроп по центру (важливий контент за промптом — у центральних 80%).
      `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${WIDTH}:${HEIGHT},setsar=1,` +
        `zoompan=${zoom}:d=${frames}:` +
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
// captionLines — необов'язковий масив підписів (по рядку на слайд): якщо
// заданий, поверх картинок другим проходом випікаємо ASS-субтитри.
export async function buildSlideshow(photoPaths, outputPath, slides = photoPaths.length, captionLines = null) {
  if (photoPaths.length < 2) {
    throw new Error(`Для монтажу треба мінімум 2 фото, отримано ${photoPaths.length}`);
  }
  const needCaptions = Array.isArray(captionLines) && captionLines.length > 0;
  if (needCaptions && captionLines.length !== photoPaths.length) {
    throw new Error(
      `Підписів (${captionLines.length}) не дорівнює фото (${photoPaths.length}) — не можу коректно накласти текст. Перевір, що рядків у script.txt стільки ж, скільки JPG.`,
    );
  }

  // Німе відео (Ken Burns + xfade). Якщо треба субтитри — спершу у тимчасовий
  // файл, потім другий прохід накладає текст.
  const silentTarget = needCaptions ? `${outputPath}.nosub.mp4` : outputPath;
  const args = ['-y'];
  for (const photoPath of photoPaths) args.push('-i', photoPath);
  args.push(
    '-filter_complex', buildFilterComplex(slides),
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-r', String(FPS),
    ...GOP_ARGS,
    '-movflags', '+faststart',
    silentTarget,
  );
  await runFfmpeg(args);

  if (needCaptions) {
    const assPath = `${outputPath}.ass`;
    await writeFile(assPath, buildAss(captionLines, toDurations(slides)), 'utf8');
    await burnSubtitles(silentTarget, assPath, outputPath);
    await rm(silentTarget, { force: true }).catch(() => {});
    await rm(assPath, { force: true }).catch(() => {});
  }
  return outputPath;
}

// Другий прохід: «випікає» ASS-субтитри у відео (libass), використовуючи
// бандлений шрифт Oswald із FONTS_DIR.
async function burnSubtitles(inPath, assPath, outPath) {
  await runFfmpeg([
    '-y',
    '-i', inPath,
    '-vf', `subtitles=${assPath}:fontsdir=${FONTS_DIR}`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-r', String(FPS),
    ...GOP_ARGS,
    '-movflags', '+faststart',
    outPath,
  ]);
  return outPath;
}

// Приводить уже змонтований ролик до специфікації Meta Reels. Потрібно лише
// для файлів, зроблених до виправлення параметрів звуку: перемонтувати їх нема
// з чого (архіви з фото давно прибрані), а публікувати як є — марно.
export async function remuxToReelsSpec(inPath, outPath) {
  await runFfmpeg([
    '-y',
    '-i', inPath,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-r', String(FPS),
    ...GOP_ARGS,
    '-af', TO_STEREO,
    ...REELS_AUDIO_ARGS,
    '-movflags', '+faststart',
    outPath,
  ]);
  return outPath;
}

// Підкладає озвучку під готове відео; тиша в кінці, якщо аудіо коротше.
//
// Параметри звуку задані явно й не успадковуються від TTS-доріжки. Meta вимагає
// для Reels стерео, 48 кГц і 128 кбіт/с, а озвучка з ElevenLabs приходить
// монофонічним MP3 на 44,1 кГц — без цих ключів AAC успадковував їх, і ролик
// не проходив за специфікацією. Facebook такий файл приймав мовчки, але не
// створював для нього «Оригінальний звук» і не пускав у стрічку Reels: у
// публічній вкладці сторінки його не бачили ні сторонні, ні підписники.
// Руками той самий ролик публікувався нормально, бо застосунок на телефоні
// перекодовує файл перед відправкою і тим самим лагодить усі ці параметри.
export async function mixAudio(videoPath, audioPath, outputPath) {
  await runFfmpeg([
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v',
    '-map', '1:a',
    '-c:v', 'copy',
    ...REELS_AUDIO_ARGS,
    '-af', `apad,${TO_STEREO}`,
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
