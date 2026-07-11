import { NextRequest } from "next/server";
import { getDb, assets } from "@shorts/shared/db";
import { r2Put } from "@shorts/shared";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

/** «Завантажити своє»: файл користувача → R2 → запис в assets. */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const form = await req.formData();
    const file = form.get("file");
    const scriptId = Number(form.get("scriptId"));
    const partIndex = Number(form.get("partIndex"));
    const visualIndex = Number(form.get("visualIndex"));

    if (!(file instanceof File)) throw new Error("Не передано файл (поле file).");
    if (!scriptId || !partIndex || !visualIndex) {
      throw new Error("Потрібні поля scriptId, partIndex, visualIndex.");
    }

    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isImage) {
      throw new Error(`Непідтримуваний тип файлу: ${file.type}. Потрібне фото або відео.`);
    }

    const ext = file.name.split(".").pop()?.toLowerCase() || (isVideo ? "mp4" : "jpg");
    const key = `assets/script-${scriptId}/part-${partIndex}/visual-${visualIndex}-upload-${Date.now()}.${ext}`;

    const buffer = Buffer.from(await file.arrayBuffer());
    await r2Put(key, buffer, file.type);

    const db = getDb();
    const [asset] = await db
      .insert(assets)
      .values({
        scriptId,
        partIndex,
        visualIndex,
        kind: isVideo ? "video" : "image",
        source: "upload",
        r2Key: key,
        mimeType: file.type,
      })
      .returning();

    return { asset };
  });
}
