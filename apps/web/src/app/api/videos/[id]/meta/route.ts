import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, videos, scripts } from "@shorts/shared/db";
import {
  askClaudeJSON,
  videoMetaPrompt,
  VIDEO_META_SCHEMA,
  VideoMeta,
} from "@shorts/shared";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

/** (Пере)генерувати заголовок/опис/хештеги для відео через Anthropic API. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleApi(async () => {
    const { id } = await params;
    const db = getDb();
    const [video] = await db.select().from(videos).where(eq(videos.id, Number(id)));
    if (!video) throw new Error(`Відео №${id} не знайдено.`);
    const [script] = await db.select().from(scripts).where(eq(scripts.id, video.scriptId));
    if (!script) throw new Error(`Сценарій №${video.scriptId} не знайдено.`);
    const part = script.parts.find((p) => p.index === video.partIndex);
    if (!part) throw new Error(`Частину ${video.partIndex} не знайдено.`);

    const meta = await askClaudeJSON<VideoMeta>(
      videoMetaPrompt({
        seriesTitle: script.title,
        partIndex: part.index,
        partsCount: script.parts.length,
        partTitle: part.title,
        voiceover: part.voiceover,
      }),
      VIDEO_META_SCHEMA as unknown as Record<string, unknown>
    );

    const [updated] = await db
      .update(videos)
      .set({ ...meta, updatedAt: new Date() })
      .where(eq(videos.id, video.id))
      .returning();

    return { video: updated };
  });
}
