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

const META_FIELDS = [
  { key: "ytTitle", label: "YouTube: заголовок", rows: 1 },
  { key: "ytDescription", label: "YouTube: опис", rows: 3 },
  { key: "ytHashtags", label: "YouTube: хештеги", rows: 1 },
  { key: "ttTitle", label: "TikTok: підпис", rows: 1 },
  { key: "ttDescription", label: "TikTok: опис", rows: 2 },
  { key: "ttHashtags", label: "TikTok: хештеги", rows: 1 },
] as const;

type MetaKey = (typeof META_FIELDS)[number]["key"];

export default function VideosPage() {
  const [items, setItems] = useState<VideoWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Partial<Record<MetaKey, string>>>>({});

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
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, []);

  function draftValue(v: VideoWithMeta, key: MetaKey): string {
    return drafts[v.id]?.[key] ?? v[key] ?? "";
  }

  function setDraft(videoId: number, key: MetaKey, value: string) {
    setDrafts((d) => ({ ...d, [videoId]: { ...d[videoId], [key]: value } }));
  }

  async function saveMeta(v: VideoWithMeta) {
    setBusy(`save-${v.id}`);
    try {
      const patch: Record<string, string> = {};
      for (const f of META_FIELDS) patch[f.key] = draftValue(v, f.key);
      await apiFetch(`/api/videos/${v.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setDrafts((d) => ({ ...d, [v.id]: {} }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function regenerateMeta(v: VideoWithMeta) {
    setBusy(`meta-${v.id}`);
    try {
      await apiFetch(`/api/videos/${v.id}/meta`, { method: "POST" });
      setDrafts((d) => ({ ...d, [v.id]: {} }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function toggleApproved(v: VideoWithMeta) {
    setBusy(`approve-${v.id}`);
    try {
      await apiFetch(`/api/videos/${v.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: !v.approved }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Відео</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Публікуються лише відео з позначкою «✅ Підтверджено». Заплануйте їх на
        сторінці «Розклад».
      </p>

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
        <div className="grid gap-6 lg:grid-cols-2">
          {items.map((v) => (
            <div key={v.id} className="card">
              <div className="flex items-start justify-between gap-2 mb-3">
                <h2 className="font-semibold text-sm leading-snug">
                  {v.scriptTitle} — частина {v.partIndex}/{v.partsCount}
                </h2>
                <span className={`badge shrink-0 ${statusColors[v.status]}`}>
                  {v.status}
                </span>
              </div>

              <div className="flex gap-4">
                <div className="w-40 shrink-0">
                  {v.status === "готове" && v.url ? (
                    <video
                      src={v.url}
                      controls
                      className="w-40 aspect-[9/16] rounded-lg bg-black object-contain"
                    />
                  ) : (
                    <div className="w-40 aspect-[9/16] rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-500 text-xs p-2 text-center">
                      {v.status === "помилка"
                        ? `Помилка: ${v.errorMessage ?? "невідома"}`
                        : v.status === "рендериться"
                          ? "Рендериться…"
                          : "У черзі"}
                    </div>
                  )}
                  {v.durationSec != null && (
                    <p className="text-xs text-zinc-500 mt-1 text-center">
                      {v.durationSec}с
                    </p>
                  )}
                </div>

                {v.status === "готове" && (
                  <div className="flex-1 space-y-2">
                    {META_FIELDS.map((f) => (
                      <div key={f.key}>
                        <label className="label">{f.label}</label>
                        <textarea
                          className="input resize-y"
                          rows={f.rows}
                          value={draftValue(v, f.key)}
                          onChange={(e) => setDraft(v.id, f.key, e.target.value)}
                        />
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        className="btn-secondary text-xs"
                        onClick={() => saveMeta(v)}
                        disabled={busy !== null}
                      >
                        {busy === `save-${v.id}` ? "Зберігаю…" : "💾 Зберегти"}
                      </button>
                      <button
                        className="btn-secondary text-xs"
                        onClick={() => regenerateMeta(v)}
                        disabled={busy !== null}
                      >
                        {busy === `meta-${v.id}` ? "Генерую…" : "🔄 Згенерувати описи"}
                      </button>
                      <button
                        className={`btn text-xs ${
                          v.approved
                            ? "bg-green-800 hover:bg-green-700 text-white"
                            : "bg-zinc-700 hover:bg-zinc-600 text-white"
                        }`}
                        onClick={() => toggleApproved(v)}
                        disabled={busy !== null}
                      >
                        {v.approved ? "✅ Підтверджено" : "Підтвердити до публікації"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
