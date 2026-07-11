import { requireEnv, optionalEnv, WordTiming } from "@shorts/shared";

/**
 * ElevenLabs TTS українською з таймкодами по словах (with-timestamps).
 * ElevenLabs повертає таймкоди ПО СИМВОЛАХ — агрегуємо їх у слова.
 * Whisper НЕ використовуємо (правило проєкту).
 */
export async function ttsWithTimestamps(text: string): Promise<{
  audio: Buffer;
  words: WordTiming[];
}> {
  const apiKey = requireEnv("ELEVENLABS_API_KEY");
  const voiceId = optionalEnv("ELEVENLABS_VOICE_ID", "");
  if (!voiceId) {
    throw new Error(
      "Відсутня змінна середовища ELEVENLABS_VOICE_ID. Оберіть голос з підтримкою української у Voice Library (див. .env.example)."
    );
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs повернув помилку ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    audio_base64?: string;
    alignment?: {
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    };
  };

  if (!data.audio_base64 || !data.alignment) {
    throw new Error("ElevenLabs не повернув audio_base64 або alignment (таймкоди).");
  }

  const audio = Buffer.from(data.audio_base64, "base64");
  const words = charactersToWords(
    data.alignment.characters,
    data.alignment.character_start_times_seconds,
    data.alignment.character_end_times_seconds
  );

  if (words.length === 0) {
    throw new Error("Не вдалося зібрати таймкоди слів з відповіді ElevenLabs.");
  }

  return { audio, words };
}

/** Агрегація посимвольних таймкодів у пословні (розділювач — пробіли/переноси). */
export function charactersToWords(
  characters: string[],
  starts: number[],
  ends: number[]
): WordTiming[] {
  const words: WordTiming[] = [];
  let current = "";
  let wordStart = 0;

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (/\s/.test(ch)) {
      if (current) {
        words.push({ word: current, start: wordStart, end: ends[i - 1] ?? starts[i] });
        current = "";
      }
    } else {
      if (!current) wordStart = starts[i];
      current += ch;
    }
  }
  if (current) {
    words.push({
      word: current,
      start: wordStart,
      end: ends[characters.length - 1] ?? wordStart + 0.3,
    });
  }
  return words;
}
