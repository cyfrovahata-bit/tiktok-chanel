/**
 * УСІ промпти до LLM — тільки в цьому файлі, щоб їх було легко правити.
 * Модель: claude-sonnet-4-6 (зафіксовано в ТЗ проєкту).
 */

export const CLAUDE_MODEL = "claude-sonnet-4-6";

/** Системний промпт для всіх запитів генерації контенту. */
export const SYSTEM_PROMPT = `Ти — досвідчений сценарист вірусних коротких відео (TikTok, YouTube Shorts) для українського каналу «Чи Ви Знали?».
Ніша каналу: дивовижні факти та корисні лайфхаки.
Аудиторія: українці 16–45 років, дивляться з телефона, гортають стрічку швидко.
Пиши ЛИШЕ сучасною українською мовою (без русизмів і кальок).
Твої тексти мають бути точними й правдивими: не вигадуй фактів, не перебільшуй цифри.`;

/** Промпт: згенерувати 5 ідей фактів. */
export function ideasPrompt(existingTitles: string[]): string {
  const avoid =
    existingTitles.length > 0
      ? `\n\nНЕ повторюй теми, які вже були:\n${existingTitles.map((t) => `- ${t}`).join("\n")}`
      : "";
  return `Запропонуй рівно 5 ідей для коротких відео (до 60 секунд) з дивовижними фактами або лайфхаками.

Вимоги до кожної ідеї:
1. Хук у перші 2 секунди: заголовок має миттєво чіпляти українську аудиторію (інтрига, шок, «а ви знали, що…», користь).
2. Потенціал серії: факт має бути достатньо глибоким, щоб розбити його на серію з 3–5 коротких відео, де кожна частина закінчується клівхенгером.
3. Візуальність: історію можна проілюструвати фото/зображеннями.
4. Правдивість: тільки реальні, перевірювані факти.

Для кожної ідеї дай:
- title: заголовок-хук українською (до 80 символів)
- description: суть факту у 2–3 реченнях
- seriesPotential: як саме розбити на серію з 3–5 частин (1–2 речення)${avoid}`;
}

/** JSON-схема відповіді для ідей (structured outputs). */
export const IDEAS_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          seriesPotential: { type: "string" },
        },
        required: ["title", "description", "seriesPotential"],
        additionalProperties: false,
      },
    },
  },
  required: ["ideas"],
  additionalProperties: false,
} as const;

/** Промпт: сценарій серії для обраної ідеї. */
export function scriptPrompt(idea: {
  title: string;
  description: string;
  seriesPotential: string;
}): string {
  return `Напиши сценарій СЕРІЇ коротких відео за цією ідеєю:

Заголовок: ${idea.title}
Суть: ${idea.description}
План серії: ${idea.seriesPotential}

Вимоги:
1. Серія з 3–5 частин. Кожна частина — окреме відео до 60 секунд (озвучка 80–130 слів).
2. Перше речення кожної частини — хук, який утримує глядача з перших 2 секунд.
3. КОЖНА частина (крім, можливо, останньої) закінчується клівхенгером — інтригою до наступної частини (наприклад: «А в наступній частині ви дізнаєтесь, чому…»). Останню частину закінчи закликом підписатися.
4. Текст озвучки (voiceover) пиши так, як його вимовить диктор: без ремарок, без заголовків, без емодзі. Числа записуй словами, якщо їх складно вимовити.
5. Для кожної частини вкажи настрій музики (mood) — рівно одне з: "енергійний", "спокійний", "загадковий", "драматичний".
6. Для кожної частини склади нумерований список потрібних візуалів (2–4 на частину): опис description українською (що в кадрі) та falPrompt — детальний промпт англійською для генерації зображення (Flux), обов'язково з "vertical 9:16 composition", фотореалістичний стиль, без тексту на зображенні.

Поля відповіді:
- title: назва серії українською
- parts: масив частин, кожна з index (з 1), title, voiceover (повний текст озвучки, ВКЛЮЧНО з клівхенгером), cliffhanger (останнє речення-гачок), mood, visuals (масив з index (з 1), description, falPrompt)`;
}

/** JSON-схема відповіді для сценарію (structured outputs). */
export const SCRIPT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          title: { type: "string" },
          voiceover: { type: "string" },
          cliffhanger: { type: "string" },
          mood: {
            type: "string",
            enum: ["енергійний", "спокійний", "загадковий", "драматичний"],
          },
          visuals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "integer" },
                description: { type: "string" },
                falPrompt: { type: "string" },
              },
              required: ["index", "description", "falPrompt"],
              additionalProperties: false,
            },
          },
        },
        required: ["index", "title", "voiceover", "cliffhanger", "mood", "visuals"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "parts"],
  additionalProperties: false,
} as const;

/** Промпт: метадані публікації (заголовок, опис, хештеги) окремо під TikTok і YouTube Shorts. */
export function videoMetaPrompt(args: {
  seriesTitle: string;
  partIndex: number;
  partsCount: number;
  partTitle: string;
  voiceover: string;
}): string {
  return `Це частина ${args.partIndex} із ${args.partsCount} серії «${args.seriesTitle}» («${args.partTitle}»).

Текст озвучки:
${args.voiceover}

Згенеруй метадані публікації українською ОКРЕМО під TikTok і під YouTube Shorts:

YouTube Shorts:
- ytTitle: заголовок до 90 символів, чіпляючий, з номером частини (наприклад «… | Частина ${args.partIndex}»)
- ytDescription: опис 2–4 речення + заклик підписатися; в кінці згадай, що це частина ${args.partIndex}/${args.partsCount}
- ytHashtags: 5–8 хештегів одним рядком через пробіл, обов'язково включи #shorts, українською/англійською мішано

TikTok:
- ttTitle: короткий чіпляючий підпис до 100 символів (у TikTok це перший рядок опису)
- ttDescription: опис 1–2 речення, розмовний тон
- ttHashtags: 5–8 хештегів одним рядком через пробіл, включи #рекомендації #україна #цікавіфакти та тематичні`;
}

/** JSON-схема відповіді для метаданих відео. */
export const VIDEO_META_SCHEMA = {
  type: "object",
  properties: {
    ytTitle: { type: "string" },
    ytDescription: { type: "string" },
    ytHashtags: { type: "string" },
    ttTitle: { type: "string" },
    ttDescription: { type: "string" },
    ttHashtags: { type: "string" },
  },
  required: [
    "ytTitle",
    "ytDescription",
    "ytHashtags",
    "ttTitle",
    "ttDescription",
    "ttHashtags",
  ],
  additionalProperties: false,
} as const;
