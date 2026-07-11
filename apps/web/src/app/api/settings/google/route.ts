import {
  getSetting,
  deleteSetting,
  GOOGLE_TOKENS_KEY,
  GoogleTokens,
} from "@shorts/shared";
import { handleApi } from "@/lib/apiHelpers";

export const dynamic = "force-dynamic";

/** Статус підключення Google-акаунта. */
export async function GET() {
  return handleApi(async () => {
    const tokens = await getSetting<GoogleTokens>(GOOGLE_TOKENS_KEY);
    return {
      connected: !!tokens?.refresh_token,
    };
  });
}

/** Відключити Google-акаунт (видалити токени з БД). */
export async function DELETE() {
  return handleApi(async () => {
    await deleteSetting(GOOGLE_TOKENS_KEY);
    return { connected: false };
  });
}
