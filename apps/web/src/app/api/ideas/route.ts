import { desc } from "drizzle-orm";
import { getDb, ideas } from "@shorts/shared/db";
import {
  askClaudeJSON,
  ideasPrompt,
  IDEAS_SCHEMA,
  IdeaCandidate,
} from "@shorts/shared";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

/** Список ідей (нові згори). */
export async function GET() {
  return handleApi(async () => {
    const db = getDb();
    const rows = await db.select().from(ideas).orderBy(desc(ideas.id));
    return { ideas: rows };
  });
}

/** «Запропонувати 5 фактів»: Anthropic API → 5 ідей → зберегти в БД. */
export async function POST() {
  return handleApi(async () => {
    const db = getDb();
    const existing = await db
      .select({ title: ideas.title })
      .from(ideas)
      .orderBy(desc(ideas.id))
      .limit(50);

    const result = await askClaudeJSON<{ ideas: IdeaCandidate[] }>(
      ideasPrompt(existing.map((r) => r.title)),
      IDEAS_SCHEMA as unknown as Record<string, unknown>
    );

    if (!result.ideas?.length) {
      throw new Error("Claude не повернув жодної ідеї.");
    }

    const inserted = await db
      .insert(ideas)
      .values(
        result.ideas.map((i) => ({
          title: i.title,
          description: i.description,
          seriesPotential: i.seriesPotential,
        }))
      )
      .returning();

    return { ideas: inserted };
  });
}
