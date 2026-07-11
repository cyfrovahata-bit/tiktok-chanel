import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, scripts, assets, videos } from "@shorts/shared/db";
import { r2SignedUrl } from "@shorts/shared";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

/** Сценарій + ассети (з тимчасовими посиланнями) + відео частин. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleApi(async () => {
    const { id } = await params;
    const db = getDb();
    const [script] = await db
      .select()
      .from(scripts)
      .where(eq(scripts.id, Number(id)));
    if (!script) throw new Error(`Сценарій №${id} не знайдено.`);

    const assetRows = await db
      .select()
      .from(assets)
      .where(eq(assets.scriptId, script.id));

    const assetsWithUrls = await Promise.all(
      assetRows.map(async (a) => ({
        ...a,
        url: await r2SignedUrl(a.r2Key),
      }))
    );

    const videoRows = await db
      .select()
      .from(videos)
      .where(eq(videos.scriptId, script.id));

    return { script, assets: assetsWithUrls, videos: videoRows };
  });
}
