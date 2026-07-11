import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, schedule } from "@shorts/shared/db";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

/** Скасувати заплановану публікацію (тільки якщо ще не виконана). */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleApi(async () => {
    const { id } = await params;
    const db = getDb();
    const [entry] = await db
      .select()
      .from(schedule)
      .where(eq(schedule.id, Number(id)));
    if (!entry) throw new Error(`Запис розкладу №${id} не знайдено.`);
    if (entry.status !== "заплановано" && entry.status !== "помилка") {
      throw new Error(`Не можна скасувати запис зі статусом «${entry.status}».`);
    }
    await db.delete(schedule).where(eq(schedule.id, entry.id));
    return { deleted: true };
  });
}
