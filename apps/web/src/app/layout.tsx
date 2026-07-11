import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Shorts Factory — Чи Ви Знали?",
  description:
    "Фабрика коротких відео для TikTok і YouTube Shorts: цікаві факти та лайфхаки українською",
};

const nav = [
  { href: "/", label: "Дашборд" },
  { href: "/ideas", label: "Ідеї" },
  { href: "/videos", label: "Відео" },
  { href: "/schedule", label: "Розклад" },
  { href: "/settings", label: "Налаштування" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="uk">
      <body>
        <div className="min-h-screen">
          <header className="border-b border-zinc-800 bg-zinc-900/70 backdrop-blur sticky top-0 z-10">
            <div className="mx-auto max-w-6xl px-4 py-3 flex items-center gap-6">
              <Link href="/" className="font-bold text-lg tracking-tight">
                🎬 AI Shorts Factory
                <span className="ml-2 text-xs font-normal text-violet-400">
                  Чи Ви Знали?
                </span>
              </Link>
              <nav className="flex gap-1 text-sm">
                {nav.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded-md px-3 py-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
