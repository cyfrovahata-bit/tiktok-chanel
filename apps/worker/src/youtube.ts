import { google, Auth } from "googleapis";
import { Readable } from "stream";
import {
  requireEnv,
  getSetting,
  setSetting,
  GOOGLE_TOKENS_KEY,
  GoogleTokens,
} from "@shorts/shared";

/**
 * OAuth2-клієнт з токенами з БД (settings).
 * Оновлені access-токени автоматично зберігаються назад у БД.
 */
async function getAuthorizedClient(): Promise<Auth.OAuth2Client> {
  const tokens = await getSetting<GoogleTokens>(GOOGLE_TOKENS_KEY);
  if (!tokens?.refresh_token) {
    throw new Error(
      "Google-акаунт не підключено. Відкрийте «Налаштування» у веб-інтерфейсі та підключіть YouTube."
    );
  }

  const client = new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET")
  );
  client.setCredentials(tokens);

  client.on("tokens", (newTokens) => {
    void setSetting(GOOGLE_TOKENS_KEY, { ...tokens, ...newTokens }).catch((e) =>
      console.error("Не вдалося зберегти оновлені токени Google:", e)
    );
  });

  return client;
}

/**
 * Завантаження відео на YouTube як Shorts (вертикальне ≤60с
 * розпізнається автоматично; #Shorts у описі допомагає алгоритму).
 * Повертає ID відео на YouTube.
 */
export async function uploadToYouTube(args: {
  videoBuffer: Buffer;
  title: string;
  description: string;
  hashtags: string;
}): Promise<string> {
  const auth = await getAuthorizedClient();
  const youtube = google.youtube({ version: "v3", auth });

  const description = `${args.description}\n\n${args.hashtags}`.trim();
  const hasShorts = /#shorts/i.test(description) || /#shorts/i.test(args.title);

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: args.title.slice(0, 100),
        description: hasShorts ? description : `${description}\n#Shorts`,
        categoryId: "27", // Education
        defaultLanguage: "uk",
        defaultAudioLanguage: "uk",
      },
      status: {
        privacyStatus: "public",
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: Readable.from(args.videoBuffer),
    },
  });

  const id = res.data.id;
  if (!id) {
    throw new Error("YouTube не повернув ID завантаженого відео.");
  }
  return id;
}
