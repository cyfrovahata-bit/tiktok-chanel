import "./loadEnv";

async function main() {
  console.log("🎬 AI Shorts Factory — worker запускається…");
  // Черга рендеру та планувальник публікацій підключаються у Фазах 3–4.
  console.log("Скелет worker готовий. Черга рендеру зʼявиться у Фазі 3.");
}

main().catch((err) => {
  console.error("Фатальна помилка worker:", err);
  process.exit(1);
});
