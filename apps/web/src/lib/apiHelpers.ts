import { NextResponse } from "next/server";

/** Обгортка для API-роутів: єдиний формат помилок українською. */
export async function handleApi<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json(data as object);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("API помилка:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
