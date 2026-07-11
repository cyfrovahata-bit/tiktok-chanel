/** Спільні типи домену «AI Shorts Factory». */

/** Настрій частини — використовується для вибору фонової музики. */
export type Mood = "енергійний" | "спокійний" | "загадковий" | "драматичний";

export const MOODS: Mood[] = ["енергійний", "спокійний", "загадковий", "драматичний"];

/** Один потрібний візуал у частині сценарію. */
export interface ScriptVisual {
  /** Порядковий номер візуалу в частині (з 1) */
  index: number;
  /** Опис українською — що має бути в кадрі (показується користувачу) */
  description: string;
  /** Готовий промпт англійською для fal.ai Flux (вертикальний формат) */
  falPrompt: string;
}

/** Одна частина серії (одне коротке відео). */
export interface ScriptPart {
  /** Номер частини серії (з 1) */
  index: number;
  /** Назва частини */
  title: string;
  /** Повний текст озвучки українською (хук + суть + клівхенгер) */
  voiceover: string;
  /** Клівхенгер — останнє речення, гачок до наступної частини */
  cliffhanger: string;
  /** Настрій для фонової музики */
  mood: Mood;
  /** Потрібні візуали (нумерований список) */
  visuals: ScriptVisual[];
}

/** Ідея, яку повертає LLM. */
export interface IdeaCandidate {
  title: string;
  description: string;
  seriesPotential: string;
}

/** Таймкод одного слова з ElevenLabs. */
export interface WordTiming {
  word: string;
  /** секунди */
  start: number;
  /** секунди */
  end: number;
}

/** Метадані публікації, які генерує LLM для одного відео. */
export interface VideoMeta {
  ytTitle: string;
  ytDescription: string;
  ytHashtags: string;
  ttTitle: string;
  ttDescription: string;
  ttHashtags: string;
}

/** Назва черги рендеру в BullMQ. */
export const RENDER_QUEUE = "render";

/** Дані джоби рендеру: одне відео = одна частина серії. */
export interface RenderJobData {
  videoId: number;
}
