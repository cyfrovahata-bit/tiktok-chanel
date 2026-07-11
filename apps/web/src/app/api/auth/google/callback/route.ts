import { NextRequest, NextResponse } from "next/server";
import { requireEnv, setSetting, GOOGLE_TOKENS_KEY } from "@shorts/shared";
import { getOAuthClient } from "@/lib/googleAuth";

export const dynamic = "force-dynamic";

/** Завершення OAuth: обмін коду на токени → збереження в БД (settings). */
export async function GET(req: NextRequest) {
  const appUrl = requireEnv("APP_URL").replace(/\/$/, "");
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    const cookieState = req.cookies.get("google_oauth_state")?.value;

    if (!code) throw new Error("Google не повернув code.");
    if (!state || !cookieState || state !== cookieState) {
      throw new Error("Невалідний state (можлива CSRF-атака). Спробуйте підключити ще раз.");
    }

    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error(
        "Google не видав refresh_token. Відкличте доступ на https://myaccount.google.com/permissions і підключіться знову."
      );
    }

    await setSetting(GOOGLE_TOKENS_KEY, tokens);

    const res = NextResponse.redirect(`${appUrl}/settings?google=ok`);
    res.cookies.delete("google_oauth_state");
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(
      `${appUrl}/settings?google_error=${encodeURIComponent(message)}`
    );
  }
}
