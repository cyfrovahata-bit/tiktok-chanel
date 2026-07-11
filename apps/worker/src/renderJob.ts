import fs from "fs";
import path from "path";
import os from "os";
import { eq, and, desc } from "drizzle-orm";
import { getDb, scripts, videos, assets as assetsTable } from "@shorts/shared/db";
import { r2Get, r2Put, RenderJobData } from "@shorts/shared";
import { ttsWithTimestamps } from "./tts";
import { renderVideo, RenderAsset } from "./ffmpegRender";

const MUSIC_DIR = path.resolve(__dirname, "../music");

/**
 * Пайплайн рендеру однієї частини серії:
 * 1) ElevenLabs TTS з таймкодами по словах → mp3 + JSON таймкодів (у R2)
 * 2) Ассети з R2 → ffmpeg (Ken Burns / відео-вставки, ASS-субтитри, музика)
 * 3) mp4 → R2, статус у БД
 */
export async function processRenderJob(data: RenderJobData): Promise<void> {
  const db = getDb();
  const [video] = await db.select().from(videos).where(eq(videos.id, data.videoId));
  if (!video) throw new Error(`Відео №${data.videoId} не знайдено в БД.`);

  const [script] = await db.select().from(scripts).where(eq(scripts.id, video.scriptId));
  if (!script) throw new Error(`Сценарій №${video.scriptId} не знайдено.`);

  const part = script.parts.find((p) => p.index === video.partIndex);
  if (!part) throw new Error(`Частину ${video.partIndex} не знайдено у сценарії №${script.id}.`);

  await db
    .update(videos)
    .set({ status: "рендериться", errorMessage: null, updatedAt: new Date() })
    .where(eq(videos.id, video.id));

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `render-${video.id}-`));
  try {
    // 1. Озвучка з таймкодами
    console.log(`🎙️ [відео ${video.id}] ElevenLabs TTS (${part.voiceover.split(/\s+/).length} слів)…`);
    const { audio, words } = await ttsWithTimestamps(part.voiceover);
    const voiceoverPath = path.join(workDir, "voiceover.mp3");
    fs.writeFileSync(voiceoverPath, audio);

    // Зберігаємо озвучку і таймкоди в R2 (для дебагу та повторного використання)
    const baseKey = `renders/script-${script.id}/part-${part.index}`;
    await r2Put(`${baseKey}/voiceover.mp3`, audio, "audio/mpeg");
    await r2Put(
      `${baseKey}/timestamps.json`,
      Buffer.from(JSON.stringify(words, null, 2)),
      "application/json"
    );

    // 2. Ассети частини (останній ассет кожного візуалу)
    const assetRows = await db
      .select()
      .from(assetsTable)
      .where(
        and(eq(assetsTable.scriptId, script.id), eq(assetsTable.partIndex, part.index))
      )
      .orderBy(desc(assetsTable.id));

    const renderAssets: RenderAsset[] = [];
    for (const visual of [...part.visuals].sort((a, b) => a.index - b.index)) {
      const row = assetRows.find((a) => a.visualIndex === visual.index);
      if (!row) {
        throw new Error(
          `Немає ассета для візуалу ${visual.index} частини ${part.index}. Завантажте або згенеруйте його у веб-інтерфейсі.`
        );
      }
      const ext = row.kind === "video" ? "mp4" : "img";
      const localPath = path.join(workDir, `asset-${visual.index}.${ext}`);
      console.log(`⬇️ [відео ${video.id}] Завантажую з R2: ${row.r2Key}`);
      fs.writeFileSync(localPath, await r2Get(row.r2Key));
      renderAssets.push({ filePath: localPath, kind: row.kind });
    }

    // 3. Рендер ffmpeg
    const outPath = path.join(workDir, "output.mp4");
    console.log(`🎬 [відео ${video.id}] Рендер ffmpeg (${renderAssets.length} слайдів)…`);
    const { durationSec } = await renderVideo({
      assets: renderAssets,
      voiceoverPath,
      words,
      mood: part.mood,
      musicDir: MUSIC_DIR,
      workDir,
      outPath,
      log: (m) => console.log(`[відео ${video.id}] ${m}`),
    });

    // 4. Результат у R2 + статус у БД
    const videoKey = `${baseKey}/video-${Date.now()}.mp4`;
    await r2Put(videoKey, fs.readFileSync(outPath), "video/mp4");

    await db
      .update(videos)
      .set({ status: "готове", r2Key: videoKey, durationSec, updatedAt: new Date() })
      .where(eq(videos.id, video.id));

    console.log(`✅ [відео ${video.id}] Готово: ${videoKey} (${durationSec}с)`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Позначити відео як помилкове (після вичерпання всіх спроб). */
export async function markRenderFailed(videoId: number, message: string): Promise<void> {
  const db = getDb();
  await db
    .update(videos)
    .set({ status: "помилка", errorMessage: message.slice(0, 1000), updatedAt: new Date() })
    .where(eq(videos.id, videoId));
}
