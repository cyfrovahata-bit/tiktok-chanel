import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import type { ScriptPart } from "../types";

/** Ідеї фактів, згенеровані LLM (по 5 за раз). */
export const ideas = pgTable("ideas", {
  id: serial("id").primaryKey(),
  /** Заголовок-хук факту */
  title: text("title").notNull(),
  /** Суть факту в 2–3 реченнях */
  description: text("description").notNull(),
  /** Як факт можна розбити на серію */
  seriesPotential: text("series_potential").notNull().default(""),
  status: text("status")
    .$type<"нова" | "обрана" | "відхилена">()
    .notNull()
    .default("нова"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** Сценарій серії з 3–5 частин для обраної ідеї. */
export const scripts = pgTable("scripts", {
  id: serial("id").primaryKey(),
  ideaId: integer("idea_id")
    .notNull()
    .references(() => ideas.id, { onDelete: "cascade" }),
  /** Назва серії */
  title: text("title").notNull(),
  /** Частини серії: текст озвучки, клівхенгер, настрій, список візуалів */
  parts: jsonb("parts").$type<ScriptPart[]>().notNull(),
  status: text("status")
    .$type<"чернетка" | "готовий">()
    .notNull()
    .default("чернетка"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** Ассети (фото/відео) для візуалів сценарію: завантажені або згенеровані. */
export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  scriptId: integer("script_id")
    .notNull()
    .references(() => scripts.id, { onDelete: "cascade" }),
  /** Номер частини серії (з 1) */
  partIndex: integer("part_index").notNull(),
  /** Номер візуалу в частині (з 1) */
  visualIndex: integer("visual_index").notNull(),
  kind: text("kind").$type<"image" | "video">().notNull().default("image"),
  source: text("source").$type<"upload" | "generated">().notNull(),
  /** Ключ обʼєкта в R2 */
  r2Key: text("r2_key").notNull(),
  mimeType: text("mime_type").notNull().default("image/jpeg"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** Відрендерені відео: одне відео = одна частина серії. */
export const videos = pgTable("videos", {
  id: serial("id").primaryKey(),
  scriptId: integer("script_id")
    .notNull()
    .references(() => scripts.id, { onDelete: "cascade" }),
  /** Номер частини серії (з 1) */
  partIndex: integer("part_index").notNull(),
  status: text("status")
    .$type<"у черзі" | "рендериться" | "готове" | "помилка">()
    .notNull()
    .default("у черзі"),
  /** Ключ mp4 у R2 (коли готове) */
  r2Key: text("r2_key"),
  durationSec: integer("duration_sec"),
  errorMessage: text("error_message"),
  /** Метадані публікації (редаговані в UI) */
  ytTitle: text("yt_title"),
  ytDescription: text("yt_description"),
  ytHashtags: text("yt_hashtags"),
  ttTitle: text("tt_title"),
  ttDescription: text("tt_description"),
  ttHashtags: text("tt_hashtags"),
  /** Явне підтвердження користувача в UI — без нього нічого не публікується */
  approved: boolean("approved").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Розклад публікацій. */
export const schedule = pgTable("schedule", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id")
    .notNull()
    .references(() => videos.id, { onDelete: "cascade" }),
  platform: text("platform").$type<"youtube" | "tiktok">().notNull(),
  /** Дата/час публікації (UTC) */
  publishAt: timestamp("publish_at").notNull(),
  status: text("status")
    .$type<"заплановано" | "виконується" | "опубліковано" | "надіслано в Telegram" | "помилка">()
    .notNull()
    .default("заплановано"),
  /** ID відео на YouTube після публікації */
  externalId: text("external_id"),
  errorMessage: text("error_message"),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** Налаштування ключ-значення (наприклад, OAuth-токени Google). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Idea = typeof ideas.$inferSelect;
export type Script = typeof scripts.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type Video = typeof videos.$inferSelect;
export type ScheduleEntry = typeof schedule.$inferSelect;
export type Setting = typeof settings.$inferSelect;
