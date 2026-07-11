/** Типи даних, які повертає наш API (серіалізовані рядки дат). */
import type { ScriptPart } from "@shorts/shared";

export interface IdeaDto {
  id: number;
  title: string;
  description: string;
  seriesPotential: string;
  status: "нова" | "обрана" | "відхилена";
  createdAt: string;
}

export interface ScriptDto {
  id: number;
  ideaId: number;
  title: string;
  parts: ScriptPart[];
  status: string;
  createdAt: string;
}

export interface AssetDto {
  id: number;
  scriptId: number;
  partIndex: number;
  visualIndex: number;
  kind: "image" | "video";
  source: "upload" | "generated";
  r2Key: string;
  mimeType: string;
  url: string;
}

export interface VideoDto {
  id: number;
  scriptId: number;
  partIndex: number;
  status: "у черзі" | "рендериться" | "готове" | "помилка";
  r2Key: string | null;
  durationSec: number | null;
  errorMessage: string | null;
  ytTitle: string | null;
  ytDescription: string | null;
  ytHashtags: string | null;
  ttTitle: string | null;
  ttDescription: string | null;
  ttHashtags: string | null;
  approved: boolean;
  createdAt: string;
}

/** fetch з обробкою помилок нашого API. */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      (data as { error?: string } | null)?.error ?? `Помилка запиту (${res.status})`
    );
  }
  return data as T;
}
