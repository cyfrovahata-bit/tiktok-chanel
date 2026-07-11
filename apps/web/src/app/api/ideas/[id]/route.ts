import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, ideas } from "@shorts/shared/db";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

/** Оновити статус ідеї («обрана» / «відхилена»). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleApi(async () => {
    const { id } = await params;
    const body = (await req.json()) as { status?: "нова" | "обрана" | "відхилена" };
    if (!body.status) {
      throw new Error("Не передано поле status.");
    }
    const db = getDb();
    const [updated] = await db
      .update(ideas)
      .set({ status: body.status })
      .where(eq(ideas.id, Number(id)))
      .returning();
    if (!updated) throw new Error(`Ідею №${id} не знайдено.`);
    return { idea: updated };
  });
}
