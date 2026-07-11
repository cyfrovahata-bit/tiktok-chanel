import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, videos } from "@shorts/shared/db";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

const EDITABLE_FIELDS = [
  "ytTitle",
  "ytDescription",
  "ytHashtags",
  "ttTitle",
  "ttDescription",
  "ttHashtags",
  "approved",
] as const;

/** Редагування метаданих відео та явне підтвердження публікації (approved). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleApi(async () => {
    const { id } = await params;
    const body = (await req.json()) as Record<string, unknown>;

    const patch: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      if (field in body) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) {
      throw new Error("Немає полів для оновлення.");
    }
    patch.updatedAt = new Date();

    const db = getDb();
    const [updated] = await db
      .update(videos)
      .set(patch)
      .where(eq(videos.id, Number(id)))
      .returning();
    if (!updated) throw new Error(`Відео №${id} не знайдено.`);
    return { video: updated };
  });
}
