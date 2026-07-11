import { desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, ideas, scripts } from "@shorts/shared/db";
import {
  askClaudeJSON,
  scriptPrompt,
  SCRIPT_SCHEMA,
  ScriptPart,
} from "@shorts/shared";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

/** Список сценаріїв. */
export async function GET() {
  return handleApi(async () => {
    const db = getDb();
    const rows = await db.select().from(scripts).orderBy(desc(scripts.id));
    return { scripts: rows };
  });
}

/** Вибір ідеї → генерація сценарію серії з 3–5 частин з клівхенгерами. */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const body = (await req.json()) as { ideaId?: number };
    if (!body.ideaId) throw new Error("Не передано ideaId.");

    const db = getDb();
    const [idea] = await db.select().from(ideas).where(eq(ideas.id, body.ideaId));
    if (!idea) throw new Error(`Ідею №${body.ideaId} не знайдено.`);

    const result = await askClaudeJSON<{ title: string; parts: ScriptPart[] }>(
      scriptPrompt(idea),
      SCRIPT_SCHEMA as unknown as Record<string, unknown>
    );

    if (!result.parts || result.parts.length < 3 || result.parts.length > 5) {
      throw new Error(
        `Claude повернув ${result.parts?.length ?? 0} частин, очікується 3–5. Спробуйте ще раз.`
      );
    }

    const [script] = await db
      .insert(scripts)
      .values({ ideaId: idea.id, title: result.title, parts: result.parts })
      .returning();

    await db.update(ideas).set({ status: "обрана" }).where(eq(ideas.id, idea.id));

    return { script };
  });
}
