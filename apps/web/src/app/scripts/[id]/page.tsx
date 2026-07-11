"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, AssetDto, ScriptDto, VideoDto } from "@/lib/types";

export default function ScriptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [script, setScript] = useState<ScriptDto | null>(null);
  const [assets, setAssets] = useState<AssetDto[]>([]);
  const [videos, setVideos] = useState<VideoDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTarget = useRef<{ partIndex: number; visualIndex: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{
        script: ScriptDto;
        assets: AssetDto[];
        videos: VideoDto[];
      }>(`/api/scripts/${id}`);
      setScript(data.script);
      setAssets(data.assets);
      setVideos(data.videos);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function assetFor(partIndex: number, visualIndex: number): AssetDto | undefined {
    return [...assets]
      .reverse()
      .find((a) => a.partIndex === partIndex && a.visualIndex === visualIndex);
  }

  function videoFor(partIndex: number): VideoDto | undefined {
    return videos.find((v) => v.partIndex === partIndex);
  }

  async function generateAsset(partIndex: number, visualIndex: number) {
    setBusy(`gen-${partIndex}-${visualIndex}`);
    setError(null);
    try {
      await apiFetch("/api/assets/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId: Number(id), partIndex, visualIndex }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function pickFile(partIndex: number, visualIndex: number) {
    uploadTarget.current = { partIndex, visualIndex };
    fileInputRef.current?.click();
  }

  async function onFileChosen(file: File | undefined) {
    const target = uploadTarget.current;
    if (!file || !target) return;
    setBusy(`upload-${target.partIndex}-${target.visualIndex}`);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("scriptId", id);
      form.set("partIndex", String(target.partIndex));
      form.set("visualIndex", String(target.visualIndex));
      await apiFetch("/api/assets/upload", { method: "POST", body: form });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function renderPart(partIndex: number) {
    setBusy(`render-${partIndex}`);
    setError(null);
    try {
      await apiFetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId: Number(id), partIndex }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!script) {
    return (
      <div>
        {error ? (
          <div className="card border-red-800 bg-red-950/40 text-red-200">{error}</div>
        ) : (
          <p className="text-zinc-400">Завантаження…</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">{script.title}</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Серія з {script.parts.length} частин · сценарій №{script.id}
      </p>

      {error && (
        <div className="card border-red-800 bg-red-950/40 text-red-200 mb-4">{error}</div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => void onFileChosen(e.target.files?.[0])}
      />

      <div className="space-y-6">
        {script.parts.map((part) => {
          const video = videoFor(part.index);
          const allVisualsReady = part.visuals.every((v) =>
            assetFor(part.index, v.index)
          );
          return (
            <div key={part.index} className="card">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold text-lg">
                  Частина {part.index}: {part.title}
                </h2>
                <span className="badge bg-zinc-800 text-zinc-300">🎵 {part.mood}</span>
              </div>

              <p className="text-sm text-zinc-300 whitespace-pre-wrap mb-2">
                {part.voiceover}
              </p>
              <p className="text-xs text-violet-300 mb-4">
                🪝 Клівхенгер: {part.cliffhanger}
              </p>

              <h3 className="text-sm font-medium text-zinc-400 mb-2">
                Потрібні візуали:
              </h3>
              <ol className="space-y-3">
                {part.visuals.map((visual) => {
                  const asset = assetFor(part.index, visual.index);
                  const genKey = `gen-${part.index}-${visual.index}`;
                  const upKey = `upload-${part.index}-${visual.index}`;
                  return (
                    <li
                      key={visual.index}
                      className="flex gap-4 items-start border border-zinc-800 rounded-lg p-3"
                    >
                      <div className="w-20 shrink-0">
                        {asset ? (
                          asset.kind === "video" ? (
                            <video
                              src={asset.url}
                              className="w-20 h-36 object-cover rounded-md"
                              muted
                            />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={asset.url}
                              alt={visual.description}
                              className="w-20 h-36 object-cover rounded-md"
                            />
                          )
                        ) : (
                          <div className="w-20 h-36 rounded-md bg-zinc-800 flex items-center justify-center text-2xl">
                            🖼️
                          </div>
                        )}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm">
                          <span className="text-zinc-500">{visual.index}.</span>{" "}
                          {visual.description}
                        </p>
                        {asset && (
                          <p className="text-xs text-zinc-500 mt-1">
                            {asset.source === "generated"
                              ? "Згенеровано ШІ"
                              : "Завантажено вручну"}
                          </p>
                        )}
                        <div className="flex gap-2 mt-2">
                          <button
                            className="btn-secondary text-xs"
                            onClick={() => pickFile(part.index, visual.index)}
                            disabled={busy !== null}
                          >
                            {busy === upKey ? "Завантажую…" : "📤 Завантажити своє"}
                          </button>
                          <button
                            className="btn-secondary text-xs"
                            onClick={() => generateAsset(part.index, visual.index)}
                            disabled={busy !== null}
                          >
                            {busy === genKey ? "Генерую…" : "🎨 Згенерувати ШІ"}
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>

              <div className="mt-4 flex items-center gap-3">
                <button
                  className="btn-primary"
                  onClick={() => renderPart(part.index)}
                  disabled={busy !== null || !allVisualsReady || video?.status === "рендериться" || video?.status === "у черзі"}
                  title={
                    allVisualsReady
                      ? "Поставити в чергу рендеру"
                      : "Спочатку додайте всі візуали"
                  }
                >
                  {busy === `render-${part.index}` ? "Додаю в чергу…" : "🎬 Рендерити"}
                </button>
                {video && (
                  <span className="badge bg-zinc-800 text-zinc-300">
                    Статус: {video.status}
                    {video.status === "помилка" && video.errorMessage
                      ? ` — ${video.errorMessage}`
                      : ""}
                  </span>
                )}
                {!allVisualsReady && (
                  <span className="text-xs text-zinc-500">
                    Для рендеру потрібні всі візуали частини
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
