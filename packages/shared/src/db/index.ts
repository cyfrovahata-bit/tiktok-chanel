import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requireEnv } from "../env";
import * as schema from "./schema";

export * from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let _db: Db | null = null;

/**
 * Ліниве підключення до БД: створюється при першому виклику,
 * щоб збірка (next build) не вимагала DATABASE_URL.
 */
export function getDb(): Db {
  if (!_db) {
    const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
    _db = drizzle(pool, { schema });
  }
  return _db;
}
