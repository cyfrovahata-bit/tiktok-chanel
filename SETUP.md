# SETUP — покрокове налаштування AI Shorts Factory

Фабрика коротких відео для TikTok і YouTube Shorts (ніша «Чи Ви Знали?»).
Цей документ — повна інструкція запуску: усі ключі, Railway, Google Cloud, музика.

---

## 1. Змінні середовища

Локально: скопіюйте `.env.example` → `.env` у **корені репозиторію** і заповніть.
На Railway: додайте змінні в **обидва** сервіси (web і worker) — див. розділ 2.

| Змінна | Для чого | Де взяти (точна інструкція) |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL (ідеї, сценарії, відео, розклад) | Локально: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=shorts postgres:16` → `postgresql://postgres:postgres@localhost:5432/shorts`. На Railway: сервіс **Postgres** → вкладка **Variables** → скопіюйте `DATABASE_URL` (або використайте Reference Variable `${{Postgres.DATABASE_URL}}`) |
| `REDIS_URL` | Черга рендеру BullMQ + планувальник | Локально: `docker run -d -p 6379:6379 redis:7` → `redis://localhost:6379`. На Railway: сервіс **Redis** → **Variables** → `REDIS_URL` (або `${{Redis.REDIS_URL}}`) |
| `ANTHROPIC_API_KEY` | Генерація ідей, сценаріїв, описів (claude-sonnet-4-6) | https://console.anthropic.com → увійти → зліва **Settings → API Keys** → кнопка **Create Key** → скопіювати (показується один раз) |
| `ELEVENLABS_API_KEY` | Озвучка українською з таймкодами по словах | https://elevenlabs.io → увійти → клік на аватар унизу зліва → **API Keys** → **Create API Key** |
| `ELEVENLABS_VOICE_ID` | Голос озвучки | https://elevenlabs.io/app/voice-library → у фільтрах знайдіть голос з підтримкою української (мультимовні v2-голоси підходять) → **Add to my voices** → **My Voices** → три крапки на голосі → **Copy Voice ID** |
| `FAL_KEY` | Генерація зображень (Flux, вертикальні 1080×1920) | https://fal.ai → увійти через GitHub/Google → https://fal.ai/dashboard/keys → **Add key** → скопіювати |
| `R2_ACCOUNT_ID` | Cloudflare-акаунт для R2 | https://dash.cloudflare.com → розділ **R2 Object Storage** → праворуч зверху блок **Account details** → **Account ID** (також видно в URL дашборда) |
| `R2_ACCESS_KEY_ID` | Ключ доступу до R2 | Дашборд R2 → праворуч **Manage R2 API Tokens** → **Create API Token** → Permissions: **Object Read & Write** → Create → скопіюйте **Access Key ID** |
| `R2_SECRET_ACCESS_KEY` | Секрет ключа R2 | Там само, поле **Secret Access Key** (показується один раз разом з Access Key ID) |
| `R2_BUCKET` | Назва бакета для файлів (ассети, mp3, mp4) | Дашборд R2 → **Create bucket** → введіть назву (наприклад `shorts-factory`) → цю ж назву впишіть у змінну. Location: Automatic |
| `GOOGLE_CLIENT_ID` | OAuth для публікації YouTube Shorts | Див. розділ 3 (Google Cloud) — **APIs & Services → Credentials** → ваш OAuth client → **Client ID** |
| `GOOGLE_CLIENT_SECRET` | Секрет OAuth-клієнта | Там само → **Client secret** |
| `TELEGRAM_BOT_TOKEN` | Бот, що шле готові TikTok-відео вам у чат | У Telegram напишіть **@BotFather** → команда `/newbot` → задайте ім'я і username → BotFather видасть токен виду `123456:ABC-DEF…` |
| `TELEGRAM_CHAT_ID` | Ваш чат, куди бот шле відео | Напишіть СВОЄМУ новому боту будь-яке повідомлення (обов'язково — інакше він не може писати першим), потім відкрийте в браузері `https://api.telegram.org/bot<ТОКЕН>/getUpdates` і скопіюйте число з `"chat":{"id":…}`. Альтернатива: напишіть боту **@userinfobot** — він покаже ваш id |
| `APP_URL` | Публічна адреса web (для OAuth-редіректу Google) | Локально `http://localhost:3000`. На Railway: сервіс web → **Settings → Networking → Generate Domain** → скопіюйте `https://…up.railway.app` |

Правило проєкту: секрети читаються тільки з `process.env`; якщо змінної нема —
застосунок кидає помилку з її назвою (жодних вигаданих ключів і заглушок).

---

## 2. Деплой на Railway (2 сервіси + PostgreSQL + Redis)

1. **Створіть проєкт**: https://railway.app → **New Project** → **Deploy from GitHub repo** → оберіть цей репозиторій. Railway створить перший сервіс — це буде **web**.
2. **Додайте бази**: у проєкті **+ New → Database → Add PostgreSQL**, потім **+ New → Database → Add Redis**.
3. **Сервіс web**:
   - Settings → **Root Directory**: залиште порожнім / `/` (корінь репо — це npm workspaces, піддиректорію ставити НЕ можна).
   - Settings → **Config File Path**: `apps/web/railway.json` (там уже прописані buildCommand і startCommand).
   - Settings → Networking → **Generate Domain** — отримаєте публічний URL (впишіть його в `APP_URL`).
   - Variables: додайте всі змінні з таблиці вище. Для баз зручно так: `DATABASE_URL = ${{Postgres.DATABASE_URL}}`, `REDIS_URL = ${{Redis.REDIS_URL}}`.
4. **Сервіс worker**: **+ New → GitHub Repo** → той самий репозиторій (другий сервіс з одного репо).
   - Settings → **Root Directory**: корінь (порожній / `/`).
   - Settings → **Config File Path**: `apps/worker/railway.json`.
   - Variables: додайте `NIXPACKS_CONFIG_FILE = apps/worker/nixpacks.toml` — це підключить `apps/worker/nixpacks.toml`, який ставить **ffmpeg** (`nixPkgs = ["...", "ffmpeg", "dejavu_fonts", "fontconfig"]`).
   - Variables: ті самі змінні середовища, що й для web (крім `APP_URL` — не обов'язково). Публічний домен worker'у не потрібен.
5. **Схема БД**: локально пропишіть у `.env` `DATABASE_URL` від Railway (вкладка Variables сервісу Postgres → `DATABASE_PUBLIC_URL`, бо внутрішній hostname з вашої машини недоступний) і виконайте `npm install && npm run db:push`. Це створить усі таблиці.
6. Задеплойте обидва сервіси (Railway робить це автоматично при push у гілку, яку ви обрали в Settings → Source).

---

## 3. Google Cloud: OAuth-креденшли для YouTube (покроково)

1. Відкрийте https://console.cloud.google.com → зверху зліва селектор проєктів → **New Project** → назва, наприклад, `shorts-factory` → **Create**.
2. Увімкніть API: меню ☰ → **APIs & Services → Library** → знайдіть **YouTube Data API v3** → **Enable**.
3. Екран згоди: **APIs & Services → OAuth consent screen** → **Get started**:
   - App name: `AI Shorts Factory`, support email — ваш.
   - Audience: **External**.
   - Створіть, потім у розділі **Audience → Test users → Add users** додайте свій Gmail (у режимі Testing публікувати може тільки тест-користувач; refresh-токени в цьому режимі живуть 7 днів — див. «Не зроблено» нижче).
4. Скоупи (не обов'язково для роботи, але правильно): **Data Access → Add or remove scopes** → додайте `https://www.googleapis.com/auth/youtube.upload` і `https://www.googleapis.com/auth/youtube.readonly`.
5. Креденшли: **APIs & Services → Credentials → + Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URIs → **Add URI**: `http://localhost:3000/api/auth/google/callback` (для локальної роботи) і `https://ВАШ-ДОМЕН-WEB.up.railway.app/api/auth/google/callback` (для Railway).
   - **Create** → скопіюйте **Client ID** → `GOOGLE_CLIENT_ID` і **Client secret** → `GOOGLE_CLIENT_SECRET`.
6. У застосунку: сторінка **Налаштування** → кнопка **«Підключити Google-акаунт»** → оберіть акаунт вашого YouTube-каналу → готово. Токени збережуться в БД, worker публікуватиме за розкладом.

---

## 4. Музика

Покладіть безкоштовні mp3-треки в `apps/worker/music/` (детальні правила іменування — в `apps/worker/music/README.md`):

- **YouTube Audio Library**: https://studio.youtube.com → Аудіотека — безкоштовно, більшість без атрибуції.
- **Pixabay Music**: https://pixabay.com/music/ — безкоштовно, без атрибуції.

Іменування за настроєм: додайте в назву файлу `upbeat`/`energetic` (енергійний), `calm`/`chill` (спокійний), `mystery` (загадковий), `dramatic`/`epic` (драматичний). Приклад: `upbeat-funky-01.mp3`. Гучність музики автоматично -18dB під голосом, з fade in/out.

⚠️ Папка в `.gitignore` — на Railway файли з вашої машини не потраплять. Варіанти: приберіть правило `apps/worker/music/*` з `.gitignore` і закомітьте треки (найпростіше), або змонтуйте Railway Volume у `apps/worker/music`.

---

## 5. Локальний запуск

```bash
cp .env.example .env       # заповніть значення
npm install
npm run db:push            # створити таблиці в PostgreSQL
npm run dev:web            # http://localhost:3000
npm run dev:worker         # в іншому терміналі (потрібен ffmpeg: apt install ffmpeg)
npm run render:sample      # тестовий рендер без LLM — дебаг ffmpeg (apps/worker/tmp/sample.mp4)
```

Потік роботи: **Ідеї** (згенерувати 5 фактів → обрати) → **Сценарій** (ассети до кожного візуалу → «Рендерити») → **Відео** (перевірити, відредагувати описи → «Підтвердити») → **Розклад** (дата/час/платформа) → worker публікує (YouTube сам, TikTok — шле в Telegram).

---

## 6. Що НЕ зроблено або зроблено спрощено (чесний список)

1. **Не тестувалося із живими ключами.** Збірка й ffmpeg-пайплайн перевірені (тестовий рендер із субтитрами працює), але виклики Anthropic / ElevenLabs / fal.ai / R2 / YouTube / Telegram з реальними ключами не проганялися. Перший прогін робіть по кроку і дивіться логи.
2. **Google OAuth у режимі Testing**: refresh-токен протухає через 7 днів. Для постійної роботи опублікуйте OAuth-екран (Audience → Publish app). Верифікацію Google проходити не обов'язково для власного використання, але Google показуватиме попередження «unverified app» при підключенні.
3. **Квота YouTube API**: завантаження відео коштує 1600 юнітів з добових 10000 → максимум ~6 публікацій на добу без підвищення квоти.
4. **TikTok — тільки через Telegram** (за ТЗ): автопублікації нема, бот шле відео+текст, публікуєте з телефона.
5. **Тривалість > 60с не обрізає текст**: якщо озвучка частини довша за 60с, відео жорстко обрізається на 60с (з попередженням у лозі). Слідкуйте, щоб частини були 80–130 слів.
6. **Ken Burns простий**: 3 ефекти по черзі (zoom-in / zoom-out / pan). Тривалість слайдів ділиться порівну по озвучці, а не по смислових блоках.
7. **Один користувач, без авторизації**: веб-інтерфейс відкритий будь-кому, хто знає URL. На Railway можна ввімкнути захист через Cloudflare Access або додати basic auth — не реалізовано.
8. **Міграції БД**: використовується `drizzle-kit push` (без файлів міграцій). Для продакшн-еволюції схеми перейдіть на `npm run db:generate` + migrate.
9. **Черга описів**: метадані генеруються в кінці render-джоби; якщо Anthropic недоступний — відео все одно «готове», а описи догенеруються кнопкою «🔄 Згенерувати описи» на сторінці «Відео».
10. **Прев'ю через presigned URL (1 година)**: якщо вкладка відкрита довше, посилання на відео/зображення протухнуть — оновіть сторінку.
11. **Розмір відео для Telegram**: бот шле файл з пам'яті; ліміт Bot API — 50 МБ. Хвилинний шортс ~10–25 МБ, зазвичай вкладається.
12. **render:sample без ключів ElevenLabs** рендерить з тишею і рівномірними таймкодами (чесно пише про це в лог) — це задумано для дебагу ffmpeg окремо.

---

## 7. Перевірочний чекліст першого запуску

- [ ] `npm run db:push` пройшов без помилок (таблиці створені)
- [ ] `npm run render:sample` створив `apps/worker/tmp/sample.mp4` (перевірка ffmpeg)
- [ ] Кнопка «Запропонувати 5 фактів» повертає 5 карток (ANTHROPIC_API_KEY)
- [ ] «Згенерувати ШІ» створює вертикальне зображення (FAL_KEY + R2)
- [ ] «Рендерити» → статус «готове» і плеєр на сторінці «Відео» (ELEVENLABS + ffmpeg + R2)
- [ ] «Налаштування» → Google підключено (GOOGLE_CLIENT_ID/SECRET + APP_URL)
- [ ] Тестова публікація на YouTube за розкладом (можна приватним відео: змініть privacyStatus у apps/worker/src/youtube.ts, якщо хочете спершу протестувати непублічно)
- [ ] Тестове відео прийшло в Telegram (TELEGRAM_BOT_TOKEN/CHAT_ID)
- [ ] Музика лежить у apps/worker/music/ і чутна у рендері
