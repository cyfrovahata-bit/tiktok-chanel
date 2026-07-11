import { and, eq, lte } from "drizzle-orm";
import { getDb, schedule, videos } from "@shorts/shared/db";
import { r2Get } from "@shorts/shared";
import { uploadToYouTube } from "./youtube";
import { sendToTelegram } from "./telegram";

let running = false;

/**
 * Планувальник: щохвилини перевіряє таблицю schedule і виконує публікації,
 * час яких настав. YouTube — публікує сам; TikTok — шле відео в Telegram.
 * Публікуються ТІЛЬКИ відео, явно підтверджені в UI (videos.approved).
 */
export function startScheduler(): void {
  console.log("⏰ Планувальник публікацій: перевірка щохвилини");
  setInterval(() => {
    if (running) return; // не накладаємо перевірки одна на одну
    running = true;
    processDueSchedule()
      .catch((e) => console.error("Помилка планувальника:", e))
      .finally(() => {
        running = false;
      });
  }, 60_000);
}

export async function processDueSchedule(): Promise<void> {
  const db = getDb();
  const due = await db
    .select()
    .from(schedule)
    .where(
      and(eq(schedule.status, "заплановано"), lte(schedule.publishAt, new Date()))
    );

  for (const entry of due) {
    console.log(
      `📤 Публікація №${entry.id}: відео ${entry.videoId} → ${entry.platform}`
    );
    await db
      .update(schedule)
      .set({ status: "виконується" })
      .where(eq(schedule.id, entry.id));

    try {
      const [video] = await db
        .select()
        .from(videos)
        .where(eq(videos.id, entry.videoId));
      if (!video) throw new Error(`Відео №${entry.videoId} не знайдено.`);
      if (!video.approved) {
        throw new Error(
          "Відео більше не підтверджене (approved=false) — публікацію скасовано."
        );
      }
      if (video.status !== "готове" || !video.r2Key) {
        throw new Error(`Відео не готове (статус «${video.status}»).`);
      }

      const videoBuffer = await r2Get(video.r2Key);

      if (entry.platform === "youtube") {
        if (!video.ytTitle) {
          throw new Error("У відео немає YouTube-заголовка. Заповніть метадані в UI.");
        }
        const externalId = await uploadToYouTube({
          videoBuffer,
          title: video.ytTitle,
          description: video.ytDescription ?? "",
          hashtags: video.ytHashtags ?? "",
        });
        await db
          .update(schedule)
          .set({
            status: "опубліковано",
            externalId,
            publishedAt: new Date(),
            errorMessage: null,
          })
          .where(eq(schedule.id, entry.id));
        console.log(`✅ YouTube: https://youtube.com/shorts/${externalId}`);
      } else {
        // TikTok: автопублікації нема (API вимагає аудиту) → шлемо в Telegram
        await sendToTelegram({
          videoBuffer,
          fileName: `tiktok-video-${video.id}.mp4`,
          title: video.ttTitle ?? video.ytTitle ?? "Відео готове",
          description: video.ttDescription ?? "",
          hashtags: video.ttHashtags ?? "",
        });
        await db
          .update(schedule)
          .set({
            status: "надіслано в Telegram",
            publishedAt: new Date(),
            errorMessage: null,
          })
          .where(eq(schedule.id, entry.id));
        console.log(`✅ Відео ${video.id} надіслано в Telegram для ручної публікації`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`❌ Публікація №${entry.id} впала: ${message}`);
      await db
        .update(schedule)
        .set({ status: "помилка", errorMessage: message.slice(0, 1000) })
        .where(eq(schedule.id, entry.id));
    }
  }
}
