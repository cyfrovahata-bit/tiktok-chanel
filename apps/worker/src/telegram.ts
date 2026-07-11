import { Bot, InputFile } from "grammy";
import { requireEnv } from "@shorts/shared";

let _bot: Bot | null = null;

function getBot(): Bot {
  if (!_bot) {
    _bot = new Bot(requireEnv("TELEGRAM_BOT_TOKEN"));
  }
  return _bot;
}

/**
 * TikTok публікується вручну: бот надсилає готове відео + текст + хештеги
 * у ваш чат, ви публікуєте з телефона.
 */
export async function sendToTelegram(args: {
  videoBuffer: Buffer;
  fileName: string;
  title: string;
  description: string;
  hashtags: string;
}): Promise<void> {
  const chatId = requireEnv("TELEGRAM_CHAT_ID");
  const bot = getBot();

  const caption = [
    `🎬 Готово до публікації в TikTok`,
    ``,
    `📌 ${args.title}`,
    ``,
    args.description,
    ``,
    args.hashtags,
  ]
    .join("\n")
    .slice(0, 1024); // ліміт caption у Telegram

  await bot.api.sendVideo(chatId, new InputFile(args.videoBuffer, args.fileName), {
    caption,
    supports_streaming: true,
  });
}
