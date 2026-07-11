import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, assets, scripts } from "@shorts/shared/db";
import { generateFluxImage, r2Put } from "@shorts/shared";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** «Згенерувати ШІ»: fal.ai Flux (вертикальний формат) → R2 → запис в assets. */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const body = (await req.json()) as {
      scriptId?: number;
      partIndex?: number;
      visualIndex?: number;
    };
    const { scriptId, partIndex, visualIndex } = body;
    if (!scriptId || !partIndex || !visualIndex) {
      throw new Error("Потрібні поля scriptId, partIndex, visualIndex.");
    }

    const db = getDb();
    const [script] = await db.select().from(scripts).where(eq(scripts.id, scriptId));
    if (!script) throw new Error(`Сценарій №${scriptId} не знайдено.`);

    const part = script.parts.find((p) => p.index === partIndex);
    const visual = part?.visuals.find((v) => v.index === visualIndex);
    if (!visual) {
      throw new Error(`Візуал ${visualIndex} частини ${partIndex} не знайдено у сценарії.`);
    }

    const { buffer, contentType } = await generateFluxImage(visual.falPrompt);

    const ext = contentType.includes("png") ? "png" : "jpg";
    const key = `assets/script-${scriptId}/part-${partIndex}/visual-${visualIndex}-flux-${Date.now()}.${ext}`;
    await r2Put(key, buffer, contentType);

    const [asset] = await db
      .insert(assets)
      .values({
        scriptId,
        partIndex,
        visualIndex,
        kind: "image",
        source: "generated",
        r2Key: key,
        mimeType: contentType,
      })
      .returning();

    return { asset };
  });
}
