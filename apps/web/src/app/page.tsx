"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/types";

interface PartInfo {
  index: number;
  title: string;
  visualsReady: number;
  visualsTotal: number;
  videoStatus: string | null;
  approved: boolean;
  stage: string;
}

interface SeriesInfo {
  scriptId: number;
  title: string;
  createdAt: string;
  parts: PartInfo[];
}

interface Dashboard {
  counters: {
    ideasNew: number;
    scripts: number;
    partsCollectingAssets: number;
    rendering: number;
    ready: number;
    scheduled: number;
    published: number;
  };
  series: SeriesInfo[];
  upcoming: {
    id: number;
    publishAt: string;
    platform: "youtube" | "tiktok";
    status: string;
    seriesTitle: string;
    partIndex: number;
  }[];
}

const stageColors: Record<string, string> = {
  візуали: "bg-zinc-800 text-zinc-400",
  "ассети готові": "bg-indigo-900/50 text-indigo-300",
  "у черзі": "bg-blue-900/50 text-blue-300",
  рендериться: "bg-yellow-900/50 text-yellow-300",
  готове: "bg-green-900/50 text-green-300",
  заплановано: "bg-violet-900/50 text-violet-300",
  опубліковано: "bg-emerald-900/60 text-emerald-300",
  помилка: "bg-red-900/50 text-red-300",
};

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setData(await apiFetch<Dashboard>("/api/dashboard"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, []);

  if (error) {
    return (
      <div className="card border-red-800 bg-red-950/40 text-red-200">
        {error}
        <p className="text-xs mt-2 text-red-300/70">
          Перевірте DATABASE_URL і чи застосована схема (npm run db:push).
        </p>
      </div>
    );
  }
  if (!data) return <p className="text-zinc-400">Завантаження…</p>;

  const pipeline = [
    { label: "Ідеї", value: data.counters.ideasNew, href: "/ideas" },
    { label: "Сценарії", value: data.counters.scripts, href: "/ideas" },
    { label: "Ассети", value: data.counters.partsCollectingAssets, href: "/ideas" },
    { label: "Рендер", value: data.counters.rendering, href: "/videos" },
    { label: "Готово", value: data.counters.ready, href: "/videos" },
    { label: "Заплановано", value: data.counters.scheduled, href: "/schedule" },
    { label: "Опубліковано", value: data.counters.published, href: "/schedule" },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Дашборд</h1>

      {/* Конвеєр статусів */}
      <div className="flex flex-wrap items-center gap-2 mb-8">
        {pipeline.map((step, i) => (
          <div key={step.label} className="flex items-center gap-2">
            <Link
              href={step.href}
              className="card px-4 py-3 text-center hover:border-violet-700 transition-colors min-w-[7rem]"
            >
              <div className="text-2xl font-bold">{step.value}</div>
              <div className="text-xs text-zinc-400">{step.label}</div>
            </Link>
            {i < pipeline.length - 1 && <span className="text-zinc-600">→</span>}
          </div>
        ))}
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Серії та прогрес частин */}
        <div className="lg:col-span-2">
          <h2 className="font-semibold mb-3">Серії</h2>
          {data.series.length === 0 ? (
            <p className="text-sm text-zinc-400">
              Ще немає серій.{" "}
              <Link href="/ideas" className="text-violet-400 hover:underline">
                Почніть з ідей →
              </Link>
            </p>
          ) : (
            <div className="space-y-3">
              {data.series.map((s) => (
                <Link
                  key={s.scriptId}
                  href={`/scripts/${s.scriptId}`}
                  className="card block hover:border-violet-700 transition-colors"
                >
                  <p className="font-medium mb-2">{s.title}</p>
                  <div className="flex flex-wrap gap-2">
                    {s.parts.map((p) => (
                      <span
                        key={p.index}
                        className={`badge ${stageColors[p.stage] ?? "bg-zinc-800 text-zinc-300"}`}
                        title={p.title}
                      >
                        Ч.{p.index}:{" "}
                        {p.stage === "візуали"
                          ? `візуали ${p.visualsReady}/${p.visualsTotal}`
                          : p.stage}
                      </span>
                    ))}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Найближчі публікації */}
        <div>
          <h2 className="font-semibold mb-3">Найближчі публікації</h2>
          {data.upcoming.length === 0 ? (
            <p className="text-sm text-zinc-400">
              Нічого не заплановано.{" "}
              <Link href="/schedule" className="text-violet-400 hover:underline">
                Розклад →
              </Link>
            </p>
          ) : (
            <div className="space-y-2">
              {data.upcoming.map((u) => (
                <div key={u.id} className="card py-3 flex items-center gap-3">
                  <span className="text-xl">{u.platform === "youtube" ? "📺" : "📱"}</span>
                  <div className="min-w-0">
                    <p className="text-sm truncate">
                      {u.seriesTitle} — ч.{u.partIndex}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {new Date(u.publishAt).toLocaleString("uk-UA")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
