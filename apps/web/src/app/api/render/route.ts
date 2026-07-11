import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, scripts, videos, assets } from "@shorts/shared/db";
import { handleApi } from "@/lib/apiHelpers";
import { getRenderQueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

/** Поставити частину серії в чергу рендеру (BullMQ "render", 3 спроби). */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const body = (await req.json()) as { scriptId?: number; partIndex?: number };
    const { scriptId, partIndex } = body;
    if (!scriptId || !partIndex) throw new Error("Потрібні поля scriptId і partIndex.");

    const db = getDb();
    const [script] = await db.select().from(scripts).where(eq(scripts.id, scriptId));
    if (!script) throw new Error(`Сценарій №${scriptId} не знайдено.`);
    const part = script.parts.find((p) => p.index === partIndex);
    if (!part) throw new Error(`Частину ${partIndex} не знайдено у сценарії.`);

    // Перевірка: усі візуали частини мають ассети
    const assetRows = await db
      .select()
      .from(assets)
      .where(and(eq(assets.scriptId, scriptId), eq(assets.partIndex, partIndex)));
    const missing = part.visuals.filter(
      (v) => !assetRows.some((a) => a.visualIndex === v.index)
    );
    if (missing.length > 0) {
      throw new Error(
        `Немає ассетів для візуалів: ${missing.map((v) => v.index).join(", ")}. Спочатку завантажте або згенеруйте їх.`
      );
    }

    // Відео-рядок: існуючий (перезапуск) або новий
    const [existing] = await db
      .select()
      .from(videos)
      .where(and(eq(videos.scriptId, scriptId), eq(videos.partIndex, partIndex)));

    let videoId: number;
    if (existing) {
      if (existing.status === "у черзі" || existing.status === "рендериться") {
        throw new Error("Ця частина вже у черзі або рендериться.");
      }
      await db
        .update(videos)
        .set({ status: "у черзі", errorMessage: null, updatedAt: new Date() })
        .where(eq(videos.id, existing.id));
      videoId = existing.id;
    } else {
      const [created] = await db
        .insert(videos)
        .values({ scriptId, partIndex })
        .returning();
      videoId = created.id;
    }

    await getRenderQueue().add(
      `render-video-${videoId}`,
      { videoId },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      }
    );

    return { videoId, status: "у черзі" };
  });
}
