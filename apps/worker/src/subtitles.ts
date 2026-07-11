import fs from "fs";
import type { WordTiming } from "@shorts/shared";

/**
 * ASS-субтитри: великий білий шрифт з чорною обводкою, центр нижньої третини,
 * поява слово за словом за таймкодами озвучки.
 */
export function buildAssSubtitles(words: WordTiming[], outPath: string): void {
  // MarginV=520 від низу кадру 1920 → текст у нижній третині (близько y≈1400)
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,DejaVu Sans,110,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,8,2,2,40,40,520,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = words.map((w, i) => {
    const start = toAssTime(w.start);
    // Тримаємо слово до початку наступного, щоб не було миготіння
    const next = words[i + 1];
    const end = toAssTime(next ? next.start : w.end + 0.4);
    const text = escapeAss(w.word.toUpperCase());
    // Легка анімація появи (fad 80мс)
    return `Dialogue: 0,${start},${end},Word,,0,0,0,,{\\fad(80,0)}${text}`;
  });

  fs.writeFileSync(outPath, header + lines.join("\n") + "\n", "utf8");
}

function toAssTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")");
}
