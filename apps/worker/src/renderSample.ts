import "./loadEnv";
/**
 * npm run render:sample — тестовий рендер із ЗАХАРДКОДЖЕНИМ сценарієм без LLM,
 * щоб дебажити ffmpeg окремо від усього пайплайна.
 *
 * - Не потребує БД, Redis і R2.
 * - Якщо є ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID — реальна озвучка з таймкодами.
 *   Якщо ні — тиша + рівномірні таймкоди (чесно повідомляється в лозі).
 * - Тестові "фото" — кольорові кадри, згенеровані ffmpeg.
 * - Результат: apps/worker/tmp/sample.mp4
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import type { WordTiming } from "@shorts/shared";
import { renderVideo, RenderAsset } from "./ffmpegRender";
import { ttsWithTimestamps } from "./tts";

const SAMPLE_TEXT =
  "Чи ви знали, що мед ніколи не псується? Археологи знаходили в єгипетських гробницях мед, якому понад три тисячі років. І він досі був їстівним. Секрет у низькій вологості та природних консервантах. А в наступній частині ви дізнаєтесь, який продукт зберігається ще довше.";

async function main() {
  const tmpDir = path.resolve(__dirname, "../tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(tmpDir, "sample-"));

  // 1. Тестові слайди: три кольорові "фото" 1620x2880 (імітація вертикальних фото)
  const colors = ["0x2a3d66", "0x66332a", "0x2a6653"];
  const assets: RenderAsset[] = colors.map((color, i) => {
    const p = path.join(workDir, `slide-${i}.png`);
    execFileSync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", `gradients=s=1620x2880:c0=${color}:c1=0x111111:d=1`,
      "-frames:v", "1",
      p,
    ]);
    return { filePath: p, kind: "image" as const };
  });
  console.log("🖼️ Згенеровано 3 тестові слайди");

  // 2. Озвучка: справжня (ElevenLabs) або тиша з рівномірними таймкодами
  let voiceoverPath = path.join(workDir, "voiceover.mp3");
  let words: WordTiming[];
  const hasEleven = !!process.env.ELEVENLABS_API_KEY && !!process.env.ELEVENLABS_VOICE_ID;

  if (hasEleven) {
    console.log("🎙️ ELEVENLABS_API_KEY знайдено — використовую справжню озвучку з таймкодами");
    const res = await ttsWithTimestamps(SAMPLE_TEXT);
    fs.writeFileSync(voiceoverPath, res.audio);
    words = res.words;
  } else {
    console.log(
      "⚠️ ELEVENLABS_API_KEY/ELEVENLABS_VOICE_ID не задано — рендер з ТИШЕЮ і рівномірними таймкодами (тільки для дебагу ffmpeg)"
    );
    const tokens = SAMPLE_TEXT.split(/\s+/);
    const perWord = 0.38;
    words = tokens.map((word, i) => ({
      word,
      start: i * perWord,
      end: (i + 1) * perWord - 0.05,
    }));
    const duration = tokens.length * perWord + 0.7;
    execFileSync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", `anullsrc=r=44100:cl=stereo:d=${duration.toFixed(2)}`,
      "-c:a", "libmp3lame",
      voiceoverPath,
    ]);
  }
  console.log(`📝 Таймкоди: ${words.length} слів, кінець ${words[words.length - 1].end.toFixed(1)}с`);

  // 3. Рендер
  const outPath = path.resolve(tmpDir, "sample.mp4");
  const { durationSec } = await renderVideo({
    assets,
    voiceoverPath,
    words,
    mood: "загадковий",
    musicDir: path.resolve(__dirname, "../music"),
    workDir,
    outPath,
  });

  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`\n✅ Тестовий рендер готовий: ${outPath} (${durationSec}с, 1080x1920)`);
}

main().catch((err) => {
  console.error("❌ render:sample впав:", err);
  process.exit(1);
});
