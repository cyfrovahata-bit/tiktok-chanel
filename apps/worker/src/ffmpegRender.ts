import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";
import type { WordTiming, Mood } from "@shorts/shared";
import { buildAssSubtitles } from "./subtitles";
import { pickMusicTrack } from "./music";

const FPS = 25;
const W = 1080;
const H = 1920;
/** Жорсткий ліміт формату Shorts/TikTok */
const MAX_DURATION = 60;

export interface RenderAsset {
  /** Локальний шлях до файлу */
  filePath: string;
  kind: "image" | "video";
}

export interface RenderVideoOptions {
  assets: RenderAsset[];
  /** mp3 озвучки */
  voiceoverPath: string;
  /** Таймкоди слів озвучки */
  words: WordTiming[];
  mood: Mood;
  musicDir: string;
  workDir: string;
  outPath: string;
  log?: (msg: string) => void;
}

/**
 * Збірка відео 1080x1920 (9:16):
 * - фото зі слайд-ефектом Ken Burns (повільний zoom/pan), тривалість по озвучці
 * - відео-ассети вставляються як є (обрізані під слайд)
 * - ASS-субтитри слово за словом
 * - фонова музика за настроєм: -18dB, fade in/out
 */
export async function renderVideo(opts: RenderVideoOptions): Promise<{ durationSec: number }> {
  const log = opts.log ?? console.log;
  if (opts.assets.length === 0) {
    throw new Error("Немає жодного ассета для рендеру.");
  }

  const lastWord = opts.words[opts.words.length - 1];
  let duration = (lastWord ? lastWord.end : 5) + 0.7;
  if (duration > MAX_DURATION) {
    log(
      `⚠️ Озвучка ${duration.toFixed(1)}с довша за ліміт ${MAX_DURATION}с — відео буде обрізано. Скоротіть текст частини.`
    );
    duration = MAX_DURATION;
  }

  const assPath = path.join(opts.workDir, "subtitles.ass");
  buildAssSubtitles(opts.words, assPath);

  const musicPath = pickMusicTrack(opts.mood, opts.musicDir);
  if (musicPath) {
    log(`🎵 Фонова музика: ${path.basename(musicPath)} (настрій: ${opts.mood})`);
  } else {
    log(`⚠️ У папці музики немає треків — рендер без фонової музики (див. apps/worker/music/README.md).`);
  }

  const slideDur = duration / opts.assets.length;
  const fontsDir = path.resolve(__dirname, "../fonts");

  const command = ffmpeg();

  // Входи: ассети
  for (const asset of opts.assets) {
    if (asset.kind === "image") {
      command.input(asset.filePath).inputOptions(["-loop 1", `-t ${slideDur.toFixed(3)}`]);
    } else {
      command.input(asset.filePath);
    }
  }
  const voiceIndex = opts.assets.length;
  command.input(opts.voiceoverPath);
  let musicIndex = -1;
  if (musicPath) {
    musicIndex = voiceIndex + 1;
    command.input(musicPath).inputOptions(["-stream_loop -1"]);
  }

  const filters: string[] = [];
  const frames = Math.max(2, Math.round(slideDur * FPS));

  opts.assets.forEach((asset, i) => {
    if (asset.kind === "image") {
      // Ken Burns: масштабуємо з запасом 2x, тоді повільний zoom/pan (3 варіанти по черзі)
      const variant = i % 3;
      let zoompan: string;
      if (variant === 0) {
        // Повільний zoom-in до центру
        zoompan = `zoompan=z='min(zoom+${(0.18 / frames).toFixed(6)},1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
      } else if (variant === 1) {
        // Повільний zoom-out
        zoompan = `zoompan=z='max(1.18-${(0.18 / frames).toFixed(6)}*on,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
      } else {
        // Повільний pan зліва направо при фіксованому zoom
        zoompan = `zoompan=z='1.15':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
      }
      filters.push(
        `[${i}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},${zoompan},setsar=1,format=yuv420p[v${i}]`
      );
    } else {
      // Відео-ассет: кроп під 9:16, обрізка під тривалість слайду
      filters.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},trim=duration=${slideDur.toFixed(3)},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v${i}]`
      );
    }
  });

  const concatInputs = opts.assets.map((_, i) => `[v${i}]`).join("");
  filters.push(`${concatInputs}concat=n=${opts.assets.length}:v=1:a=0[vcat]`);

  // ASS-субтитри (шрифт DejaVu Sans Bold бандлиться в apps/worker/fonts)
  const assEscaped = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const fontsEscaped = fontsDir.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  filters.push(`[vcat]ass='${assEscaped}':fontsdir='${fontsEscaped}'[vout]`);

  // Аудіо: голос + музика -18dB з fade in/out
  if (musicPath) {
    const fadeOutStart = Math.max(0, duration - 2).toFixed(3);
    filters.push(
      `[${musicIndex}:a]atrim=duration=${duration.toFixed(3)},volume=-18dB,afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart}:d=2[bgm]`
    );
    filters.push(
      `[${voiceIndex}:a][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
    );
  } else {
    filters.push(`[${voiceIndex}:a]anull[aout]`);
  }

  await new Promise<void>((resolve, reject) => {
    command
      .complexFilter(filters)
      .outputOptions([
        "-map [vout]",
        "-map [aout]",
        `-t ${duration.toFixed(3)}`,
        "-c:v libx264",
        "-preset medium",
        "-crf 21",
        "-pix_fmt yuv420p",
        `-r ${FPS}`,
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .output(opts.outPath)
      .on("start", (cmd: string) => log(`ffmpeg старт: ${cmd.slice(0, 300)}…`))
      .on("stderr", () => {
        /* прибираємо шум ffmpeg з логів; помилки прийдуть у 'error' */
      })
      .on("error", (err: Error) => reject(new Error(`Помилка ffmpeg: ${err.message}`)))
      .on("end", () => resolve())
      .run();
  });

  if (!fs.existsSync(opts.outPath) || fs.statSync(opts.outPath).size === 0) {
    throw new Error("ffmpeg завершився, але вихідний файл порожній.");
  }

  return { durationSec: Math.round(duration) };
}
