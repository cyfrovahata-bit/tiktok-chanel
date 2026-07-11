"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, IdeaDto } from "@/lib/types";

const statusColors: Record<IdeaDto["status"], string> = {
  нова: "bg-blue-900/50 text-blue-300",
  обрана: "bg-green-900/50 text-green-300",
  відхилена: "bg-zinc-800 text-zinc-500",
};

export default function IdeasPage() {
  const router = useRouter();
  const [ideas, setIdeas] = useState<IdeaDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [creatingScript, setCreatingScript] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiFetch<{ ideas: IdeaDto[] }>("/api/ideas");
      setIdeas(data.ideas);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      await apiFetch("/api/ideas", { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function createScript(ideaId: number) {
    setCreatingScript(ideaId);
    setError(null);
    try {
      const data = await apiFetch<{ script: { id: number } }>("/api/scripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId }),
      });
      router.push(`/scripts/${data.script.id}`);
    } catch (e) {
      setError((e as Error).message);
      setCreatingScript(null);
    }
  }

  async function discard(ideaId: number) {
    setError(null);
    try {
      await apiFetch(`/api/ideas/${ideaId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "відхилена" }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Ідеї</h1>
        <button className="btn-primary" onClick={generate} disabled={generating}>
          {generating ? "Генерую…" : "✨ Запропонувати 5 фактів"}
        </button>
      </div>

      {error && (
        <div className="card border-red-800 bg-red-950/40 text-red-200 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-zinc-400">Завантаження…</p>
      ) : ideas.length === 0 ? (
        <p className="text-zinc-400">
          Поки що немає ідей. Натисніть «Запропонувати 5 фактів».
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {ideas.map((idea) => (
            <div key={idea.id} className="card flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold text-lg leading-snug">{idea.title}</h2>
                <span className={`badge shrink-0 ${statusColors[idea.status]}`}>
                  {idea.status}
                </span>
              </div>
              <p className="text-sm text-zinc-300">{idea.description}</p>
              <p className="text-xs text-zinc-500">
                <span className="font-medium text-zinc-400">Серія:</span>{" "}
                {idea.seriesPotential}
              </p>
              {idea.status !== "відхилена" && (
                <div className="flex gap-2 mt-auto pt-2">
                  <button
                    className="btn-primary"
                    onClick={() => createScript(idea.id)}
                    disabled={creatingScript !== null}
                  >
                    {creatingScript === idea.id
                      ? "Пишу сценарій…"
                      : "📝 Створити сценарій серії"}
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => discard(idea.id)}
                    disabled={creatingScript !== null}
                  >
                    Відхилити
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
