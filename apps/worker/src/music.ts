import fs from "fs";
import path from "path";
import type { Mood } from "@shorts/shared";

/** Ключові слова в назвах файлів для кожного настрою (див. music/README.md). */
const MOOD_KEYWORDS: Record<Mood, string[]> = {
  енергійний: ["upbeat", "energetic"],
  спокійний: ["calm", "chill"],
  загадковий: ["mystery", "mysterious"],
  драматичний: ["dramatic", "epic"],
};

/**
 * Вибір фонового треку за настроєм сценарію з папки apps/worker/music/.
 * Якщо трек за настроєм не знайдено — випадковий mp3; якщо папка порожня — null.
 */
export function pickMusicTrack(mood: Mood, musicDir: string): string | null {
  if (!fs.existsSync(musicDir)) return null;
  const tracks = fs
    .readdirSync(musicDir)
    .filter((f) => f.toLowerCase().endsWith(".mp3"));
  if (tracks.length === 0) return null;

  const keywords = MOOD_KEYWORDS[mood] ?? [];
  const matching = tracks.filter((f) =>
    keywords.some((k) => f.toLowerCase().includes(k))
  );
  const pool = matching.length > 0 ? matching : tracks;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  return path.join(musicDir, chosen);
}
