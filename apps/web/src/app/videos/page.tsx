"use client";

import { useEffect, useState } from "react";
import { apiFetch, VideoDto } from "@/lib/types";

interface VideoWithMeta extends VideoDto {
  scriptTitle: string;
  partsCount: number;
  url: string | null;
}

const statusColors: Record<VideoDto["status"], string> = {
  "у черзі": "bg-blue-900/50 text-blue-300",
  рендериться: "bg-yellow-900/50 text-yellow-300",
  готове: "bg-green-900/50 text-green-300",
  помилка: "bg-red-900/50 text-red-300",
};

export default function VideosPage() {
  const [items, setItems] = useState<VideoWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiFetch<{ videos: VideoWithMeta[] }>("/api/videos");
      setItems(data.videos);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Автооновлення статусів рендеру кожні 10 секунд
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Відео</h1>

      {error && (
        <div className="card border-red-800 bg-red-950/40 text-red-200 mb-4">{error}</div>
      )}

      {loading ? (
        <p className="text-zinc-400">Завантаження…</p>
      ) : items.length === 0 ? (
        <p className="text-zinc-400">
          Ще немає відео. Створіть сценарій на сторінці «Ідеї», додайте візуали і
          натисніть «Рендерити».
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((v) => (
            <div key={v.id} className="card">
              <div className="flex items-start justify-between gap-2 mb-2">
                <h2 className="font-semibold text-sm leading-snug">
                  {v.scriptTitle} — частина {v.partIndex}/{v.partsCount}
                </h2>
                <span className={`badge shrink-0 ${statusColors[v.status]}`}>
                  {v.status}
                </span>
              </div>

              {v.status === "готове" && v.url ? (
                <video
                  src={v.url}
                  controls
                  className="w-full aspect-[9/16] rounded-lg bg-black object-contain"
                />
              ) : (
                <div className="w-full aspect-[9/16] rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-500 text-sm p-4 text-center">
                  {v.status === "помилка"
                    ? `Помилка: ${v.errorMessage ?? "невідома"}`
                    : v.status === "рендериться"
                      ? "Рендериться… (сторінка оновлюється автоматично)"
                      : "У черзі на рендер"}
                </div>
              )}

              {v.durationSec != null && (
                <p className="text-xs text-zinc-500 mt-2">Тривалість: {v.durationSec}с</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
