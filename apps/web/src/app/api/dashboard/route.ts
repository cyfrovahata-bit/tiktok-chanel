import { asc, desc, eq } from "drizzle-orm";
import { getDb, ideas, scripts, assets, videos, schedule } from "@shorts/shared/db";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

/** Етап конвеєра для однієї частини серії. */
export type PartStage =
  | "візуали"
  | "ассети готові"
  | "у черзі"
  | "рендериться"
  | "готове"
  | "заплановано"
  | "опубліковано"
  | "помилка";

/** Агрегація всього конвеєра для дашборда. */
export async function GET() {
  return handleApi(async () => {
    const db = getDb();
    const [ideaRows, scriptRows, assetRows, videoRows, scheduleRows] =
      await Promise.all([
        db.select().from(ideas).orderBy(desc(ideas.id)),
        db.select().from(scripts).orderBy(desc(scripts.id)),
        db.select().from(assets),
        db.select().from(videos),
        db.select().from(schedule).orderBy(asc(schedule.publishAt)),
      ]);

    const series = scriptRows.map((script) => {
      const parts = script.parts.map((part) => {
        const partAssets = assetRows.filter(
          (a) => a.scriptId === script.id && a.partIndex === part.index
        );
        const readyVisuals = new Set(partAssets.map((a) => a.visualIndex)).size;
        const video = videoRows.find(
          (v) => v.scriptId === script.id && v.partIndex === part.index
        );
        const entries = video
          ? scheduleRows.filter((s) => s.videoId === video.id)
          : [];

        let stage: PartStage = "візуали";
        if (
          entries.some(
            (s) => s.status === "опубліковано" || s.status === "надіслано в Telegram"
          )
        ) {
          stage = "опубліковано";
        } else if (entries.some((s) => s.status === "заплановано" || s.status === "виконується")) {
          stage = "заплановано";
        } else if (video?.status === "готове") {
          stage = "готове";
        } else if (video?.status === "рендериться") {
          stage = "рендериться";
        } else if (video?.status === "у черзі") {
          stage = "у черзі";
        } else if (video?.status === "помилка") {
          stage = "помилка";
        } else if (readyVisuals >= part.visuals.length && part.visuals.length > 0) {
          stage = "ассети готові";
        }

        return {
          index: part.index,
          title: part.title,
          visualsReady: readyVisuals,
          visualsTotal: part.visuals.length,
          videoStatus: video?.status ?? null,
          approved: video?.approved ?? false,
          stage,
        };
      });

      return {
        scriptId: script.id,
        title: script.title,
        createdAt: script.createdAt,
        parts,
      };
    });

    // Лічильники конвеєра
    const allParts = series.flatMap((s) => s.parts);
    const counters = {
      ideasNew: ideaRows.filter((i) => i.status === "нова").length,
      scripts: scriptRows.length,
      partsCollectingAssets: allParts.filter(
        (p) => p.stage === "візуали" || p.stage === "ассети готові"
      ).length,
      rendering: allParts.filter(
        (p) => p.stage === "у черзі" || p.stage === "рендериться" || p.stage === "помилка"
      ).length,
      ready: allParts.filter((p) => p.stage === "готове").length,
      scheduled: allParts.filter((p) => p.stage === "заплановано").length,
      published: allParts.filter((p) => p.stage === "опубліковано").length,
    };

    // Найближчі публікації
    const upcoming = scheduleRows
      .filter((s) => s.status === "заплановано" || s.status === "виконується")
      .slice(0, 10)
      .map((s) => {
        const video = videoRows.find((v) => v.id === s.videoId);
        const script = video
          ? scriptRows.find((sc) => sc.id === video.scriptId)
          : undefined;
        return {
          id: s.id,
          publishAt: s.publishAt,
          platform: s.platform,
          status: s.status,
          seriesTitle: script?.title ?? "?",
          partIndex: video?.partIndex ?? 0,
        };
      });

    return { counters, series, upcoming };
  });
}
