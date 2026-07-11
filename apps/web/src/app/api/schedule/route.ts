import { desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, schedule, videos, scripts } from "@shorts/shared/db";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

/** Список запланованих публікацій з інформацією про відео. */
export async function GET() {
  return handleApi(async () => {
    const db = getDb();
    const rows = await db
      .select({
        entry: schedule,
        video: videos,
        scriptTitle: scripts.title,
      })
      .from(schedule)
      .innerJoin(videos, eq(schedule.videoId, videos.id))
      .innerJoin(scripts, eq(videos.scriptId, scripts.id))
      .orderBy(desc(schedule.publishAt));
    return {
      entries: rows.map((r) => ({
        ...r.entry,
        video: r.video,
        scriptTitle: r.scriptTitle,
      })),
    };
  });
}

/** Запланувати публікацію. ТІЛЬКИ для відео, явно підтверджених у UI. */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const body = (await req.json()) as {
      videoId?: number;
      platform?: "youtube" | "tiktok";
      publishAt?: string;
    };
    if (!body.videoId || !body.platform || !body.publishAt) {
      throw new Error("Потрібні поля videoId, platform, publishAt.");
    }
    if (body.platform !== "youtube" && body.platform !== "tiktok") {
      throw new Error("platform має бути youtube або tiktok.");
    }
    const publishAt = new Date(body.publishAt);
    if (Number.isNaN(publishAt.getTime())) {
      throw new Error("Невалідна дата publishAt.");
    }

    const db = getDb();
    const [video] = await db.select().from(videos).where(eq(videos.id, body.videoId));
    if (!video) throw new Error(`Відео №${body.videoId} не знайдено.`);
    if (video.status !== "готове" || !video.r2Key) {
      throw new Error("Планувати можна лише відрендерені відео (статус «готове»).");
    }
    if (!video.approved) {
      throw new Error(
        "Відео не підтверджене. Спочатку підтвердіть його на сторінці «Відео» — без явного підтвердження нічого не публікується."
      );
    }

    const [entry] = await db
      .insert(schedule)
      .values({ videoId: body.videoId, platform: body.platform, publishAt })
      .returning();

    return { entry };
  });
}
