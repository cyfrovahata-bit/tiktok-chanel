import { desc, eq } from "drizzle-orm";
import { getDb, videos, scripts } from "@shorts/shared/db";
import { r2SignedUrl } from "@shorts/shared";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

/** Усі відео з назвами серій і тимчасовими посиланнями для прев'ю. */
export async function GET() {
  return handleApi(async () => {
    const db = getDb();
    const rows = await db
      .select({
        video: videos,
        scriptTitle: scripts.title,
        partsCount: scripts.parts,
      })
      .from(videos)
      .innerJoin(scripts, eq(videos.scriptId, scripts.id))
      .orderBy(desc(videos.id));

    const result = await Promise.all(
      rows.map(async (r) => ({
        ...r.video,
        scriptTitle: r.scriptTitle,
        partsCount: Array.isArray(r.partsCount) ? r.partsCount.length : 0,
        url: r.video.r2Key ? await r2SignedUrl(r.video.r2Key) : null,
      }))
    );

    return { videos: result };
  });
}
