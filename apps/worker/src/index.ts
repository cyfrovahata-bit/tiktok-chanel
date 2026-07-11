import "./loadEnv";
import { Worker, Job } from "bullmq";
import { RENDER_QUEUE, RenderJobData, redisConnectionOptions } from "@shorts/shared";
import { processRenderJob, markRenderFailed } from "./renderJob";

async function main() {
  console.log("🎬 AI Shorts Factory — worker запускається…");

  const connection = redisConnectionOptions();

  const renderWorker = new Worker<RenderJobData>(
    RENDER_QUEUE,
    async (job: Job<RenderJobData>) => {
      console.log(`▶️ Джоба рендеру ${job.id} (відео ${job.data.videoId}), спроба ${job.attemptsMade + 1}`);
      await processRenderJob(job.data);
    },
    {
      connection,
      concurrency: 1, // ffmpeg їсть CPU — рендеримо по одному
    }
  );

  renderWorker.on("failed", (job, err) => {
    const attempts = (job?.opts.attempts ?? 1) as number;
    const attemptsMade = job?.attemptsMade ?? 1;
    console.error(
      `❌ Джоба ${job?.id} впала (спроба ${attemptsMade}/${attempts}): ${err.message}`
    );
    if (job && attemptsMade >= attempts) {
      // Усі 3 спроби вичерпано — фіксуємо помилку в БД
      void markRenderFailed(job.data.videoId, err.message).catch((e) =>
        console.error("Не вдалося записати помилку в БД:", e)
      );
    }
  });

  renderWorker.on("completed", (job) => {
    console.log(`✅ Джоба ${job.id} завершена`);
  });

  console.log(`👂 Слухаю чергу "${RENDER_QUEUE}"…`);

  // Акуратне завершення
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      console.log(`Отримав ${sig}, завершую…`);
      await renderWorker.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("Фатальна помилка worker:", err);
  process.exit(1);
});
