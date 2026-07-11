import { eq } from "drizzle-orm";
import { getDb, settings } from "./db";

/** Прочитати налаштування за ключем (null, якщо нема). */
export async function getSetting<T>(key: string): Promise<T | null> {
  const db = getDb();
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row ? (row.value as T) : null;
}

/** Записати налаштування (upsert). */
export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = getDb();
  await db
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
}

/** Видалити налаштування. */
export async function deleteSetting(key: string): Promise<void> {
  const db = getDb();
  await db.delete(settings).where(eq(settings.key, key));
}

/** Ключ, під яким зберігаються OAuth-токени Google (YouTube). */
export const GOOGLE_TOKENS_KEY = "google_tokens";

/** Форма токенів Google у таблиці settings. */
export interface GoogleTokens {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}
