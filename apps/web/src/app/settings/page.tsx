"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/types";

function SettingsContent() {
  const searchParams = useSearchParams();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const oauthError = searchParams.get("google_error");
  const oauthOk = searchParams.get("google") === "ok";

  async function load() {
    try {
      const data = await apiFetch<{ connected: boolean }>("/api/settings/google");
      setConnected(data.connected);
    } catch (e) {
      setError((e as Error).message);
      setConnected(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function disconnect() {
    if (!confirm("Відключити Google-акаунт? Заплановані публікації на YouTube перестануть працювати.")) return;
    setBusy(true);
    try {
      await apiFetch("/api/settings/google", { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Налаштування</h1>

      {oauthOk && (
        <div className="card border-green-800 bg-green-950/40 text-green-200 mb-4">
          ✅ Google-акаунт успішно підключено!
        </div>
      )}
      {oauthError && (
        <div className="card border-red-800 bg-red-950/40 text-red-200 mb-4">
          Помилка підключення Google: {oauthError}
        </div>
      )}
      {error && (
        <div className="card border-red-800 bg-red-950/40 text-red-200 mb-4">{error}</div>
      )}

      <div className="card">
        <h2 className="font-semibold text-lg mb-2">📺 YouTube</h2>
        <p className="text-sm text-zinc-400 mb-4">
          Підключіть Google-акаунт з вашим YouTube-каналом, щоб worker міг
          автоматично публікувати Shorts за розкладом. Токени зберігаються в БД.
        </p>
        {connected === null ? (
          <p className="text-zinc-500 text-sm">Перевіряю статус…</p>
        ) : connected ? (
          <div className="flex items-center gap-3">
            <span className="badge bg-green-900/50 text-green-300">Підключено</span>
            <button className="btn-danger" onClick={disconnect} disabled={busy}>
              Відключити
            </button>
          </div>
        ) : (
          <a href="/api/auth/google" className="btn-primary inline-flex">
            🔗 Підключити Google-акаунт
          </a>
        )}
      </div>

      <div className="card mt-4">
        <h2 className="font-semibold text-lg mb-2">📱 TikTok</h2>
        <p className="text-sm text-zinc-400">
          Автопублікація в TikTok не підтримується (API вимагає аудиту застосунку).
          Замість цього в час, запланований у «Розкладі», Telegram-бот надішле вам
          готове відео з текстом і хештегами — опублікуйте його з телефона вручну.
          Потрібні змінні середовища <code className="text-zinc-300">TELEGRAM_BOT_TOKEN</code> і{" "}
          <code className="text-zinc-300">TELEGRAM_CHAT_ID</code> (див. .env.example).
        </p>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<p className="text-zinc-400">Завантаження…</p>}>
      <SettingsContent />
    </Suspense>
  );
}
