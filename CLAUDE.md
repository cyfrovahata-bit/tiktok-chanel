# AI Shorts Factory

Фабрика коротких відео для TikTok і YouTube Shorts українською мовою.
Ніша каналу: **«Чи Ви Знали?»** — цікаві факти та лайфхаки.

## Архітектура

Монорепо на npm workspaces:

```
apps/web        Next.js (App Router) + Tailwind — веб-інтерфейс (усе українською)
apps/worker     Node.js + BullMQ (Redis) — рендер відео (ffmpeg) і публікація за розкладом
packages/shared Спільний код: Drizzle-схема БД, типи, промпти, env-хелпери, R2, LLM
```

Потік даних (конвеєр):

```
Ідеї (Anthropic) → Сценарій серії 3–5 частин → Ассети (upload у R2 / fal.ai Flux)
→ Черга BullMQ "render" → worker: ElevenLabs TTS (таймкоди по словах) + ffmpeg
  (Ken Burns, ASS-субтитри слово за словом, фонова музика) → mp4 у R2
→ Описи/хештеги (Anthropic) → підтвердження в UI → розклад
→ worker щохвилини: YouTube (OAuth2, публікує сам) / TikTok (шле в Telegram, публікація вручну)
```

Зовнішні сервіси:

- **PostgreSQL** (Drizzle ORM, схема в `packages/shared/src/db/schema.ts`)
- **Redis** (BullMQ, черга `render`)
- **Cloudflare R2** через AWS SDK v3 (S3-сумісний API) — усі файли (ассети, аудіо, mp4)
- **Anthropic API** (`claude-sonnet-4-6`) — ідеї, сценарії, описи. Усі промпти ТІЛЬКИ в `packages/shared/src/prompts.ts`
- **ElevenLabs** — озвучка українською з `with_timestamps` (таймкоди по словах). Whisper НЕ використовуємо
- **fal.ai (Flux)** — генерація вертикальних зображень
- **ffmpeg** (fluent-ffmpeg) — завжди 1080x1920, 9:16, до 60 сек

## Команди

```bash
npm install                 # встановити все (workspaces)
npm run build               # збірка всіх пакетів: shared → web → worker
npm run dev:web             # dev-сервер веб-інтерфейсу (localhost:3000)
npm run dev:worker          # dev-режим worker (tsx watch)
npm run db:push             # застосувати Drizzle-схему до БД (DATABASE_URL з .env)
npm run db:generate         # згенерувати SQL-міграції
npm run render:sample       # тестовий рендер із захардкодженим сценарієм (без LLM) — дебаг ffmpeg
```

Локальний запуск: скопіюйте `.env.example` → `.env` у КОРЕНІ репозиторію та заповніть.
Обидва застосунки читають `.env` з кореня. Потрібні PostgreSQL і Redis (можна Docker).

## Правила проєкту

1. **Жодних вигаданих API-ключів чи заглушок, що імітують успіх.** Усі секрети лише з
   `process.env` через `requireEnv()` з `@shorts/shared` — якщо змінної нема, кидається
   помилка з її назвою.
2. **Обробка помилок у всіх зовнішніх викликах**; джоби BullMQ мають `attempts: 3`
   з експоненційним backoff.
3. **Нічого не публікується автоматично без явного підтвердження в UI**
   (поле `videos.approved`).
4. Усі промпти до LLM — тільки в `packages/shared/src/prompts.ts`.
5. Весь UI-текст українською мовою.
6. Відео завжди 1080x1920 (9:16), до 60 секунд.
7. `@shorts/shared` компілюється в `dist/` (CommonJS) — перед dev/build інших пакетів
   збирайте shared (`npm run build -w packages/shared`); кореневі скрипти це вже роблять.

## Деплой (Railway)

2 сервіси з одного репо + PostgreSQL + Redis. Детально — у `SETUP.md`.

- **web**: config file path `apps/web/railway.json`
- **worker**: config file path `apps/worker/railway.json` (nixpacks ставить `ffmpeg`
  і шрифти DejaVu через `apps/worker/nixpacks.toml`)
- Root directory обох сервісів — корінь репозиторію (не піддиректорія!), бо npm workspaces.
