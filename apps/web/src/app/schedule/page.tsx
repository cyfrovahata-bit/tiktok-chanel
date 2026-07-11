"use client";

import { useEffect, useState } from "react";
import { apiFetch, VideoDto } from "@/lib/types";

interface VideoWithMeta extends VideoDto {
  scriptTitle: string;
  partsCount: number;
  url: string | null;
}

interface ScheduleEntry {
  id: number;
  videoId: number;
  platform: "youtube" | "tiktok";
  publishAt: string;
  status: string;
  externalId: string | null;
  errorMessage: string | null;
  publishedAt: string | null;
  video: VideoDto;
  scriptTitle: string;
}

const entryStatusColors: Record<string, string> = {
  заплановано: "bg-blue-900/50 text-blue-300",
  виконується: "bg-yellow-900/50 text-yellow-300",
  опубліковано: "bg-green-900/50 text-green-300",
  "надіслано в Telegram": "bg-green-900/50 text-green-300",
  помилка: "bg-red-900/50 text-red-300",
};

function defaultDateTime(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SchedulePage() {
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [videos, setVideos] = useState<VideoWithMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [videoId, setVideoId] = useState<number | "">("");
  const [platform, setPlatform] = useState<"youtube" | "tiktok">("youtube");
  const [publishAt, setPublishAt] = useState(defaultDateTime());

  async function load() {
    try {
      const [s, v] = await Promise.all([
        apiFetch<{ entries: ScheduleEntry[] }>("/api/schedule"),
        apiFetch<{ videos: VideoWithMeta[] }>("/api/videos"),
      ]);
      setEntries(s.entries);
      setVideos(v.videos.filter((x) => x.status === "готове" && x.approved));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, []);

  async function schedule() {
    if (!videoId) {
      setError("Оберіть відео.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId,
          platform,
          publishAt: new Date(publishAt).toISOString(),
        }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: number) {
    setBusy(true);
    try {
      await apiFetch(`/api/schedule/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Розклад публікацій</h1>

      {error && (
        <div className="card border-red-800 bg-red-950/40 text-red-200 mb-4">{error}</div>
      )}

      <div className="card mb-8">
        <h2 className="font-semibold mb-3">Запланувати публікацію</h2>
        {videos.length === 0 ? (
          <p className="text-sm text-zinc-400">
            Немає підтверджених готових відео. Відрендеріть відео і підтвердіть його
            на сторінці «Відео».
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-4 items-end">
            <div className="md:col-span-2">
              <label className="label">Відео (тільки підтверджені)</label>
              <select
                className="input"
                value={videoId}
                onChange={(e) => setVideoId(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">— оберіть відео —</option>
                {videos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.scriptTitle} — частина {v.partIndex}/{v.partsCount}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Платформа</label>
              <select
                className="input"
                value={platform}
                onChange={(e) => setPlatform(e.target.value as "youtube" | "tiktok")}
              >
                <option value="youtube">YouTube Shorts (авто)</option>
                <option value="tiktok">TikTok (через Telegram)</option>
              </select>
            </div>
            <div>
              <label className="label">Дата і час</label>
              <input
                type="datetime-local"
                className="input"
                value={publishAt}
                onChange={(e) => setPublishAt(e.target.value)}
              />
            </div>
            <div className="md:col-span-4">
              <button className="btn-primary" onClick={schedule} disabled={busy}>
                📅 Запланувати
              </button>
            </div>
          </div>
        )}
      </div>

      <h2 className="font-semibold mb-3">Заплановано та виконано</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-zinc-400">Поки що нічого не заплановано.</p>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <div key={e.id} className="card flex items-center gap-4 py-3">
              <div className="text-2xl">{e.platform === "youtube" ? "📺" : "📱"}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {e.scriptTitle} — частина {e.video.partIndex}
                </p>
                <p className="text-xs text-zinc-500">
                  {new Date(e.publishAt).toLocaleString("uk-UA")} ·{" "}
                  {e.platform === "youtube" ? "YouTube Shorts" : "TikTok (Telegram)"}
                  {e.externalId && (
                    <>
                      {" · "}
                      <a
                        className="text-violet-400 hover:underline"
                        href={`https://youtube.com/shorts/${e.externalId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        відкрити
                      </a>
                    </>
                  )}
                </p>
                {e.errorMessage && (
                  <p className="text-xs text-red-400 mt-1">{e.errorMessage}</p>
                )}
              </div>
              <span
                className={`badge shrink-0 ${entryStatusColors[e.status] ?? "bg-zinc-800 text-zinc-300"}`}
              >
                {e.status}
              </span>
              {(e.status === "заплановано" || e.status === "помилка") && (
                <button
                  className="btn-danger text-xs"
                  onClick={() => cancel(e.id)}
                  disabled={busy}
                >
                  Скасувати
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
