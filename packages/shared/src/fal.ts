import { requireEnv } from "./env";

/**
 * Генерація зображення через fal.ai Flux (синхронний REST-виклик fal.run).
 * Повертає Buffer з JPEG/PNG. Формат завжди вертикальний (9:16).
 */
export async function generateFluxImage(prompt: string): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  const falKey = requireEnv("FAL_KEY");

  const res = await fetch("https://fal.run/fal-ai/flux/dev", {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      image_size: { width: 1080, height: 1920 },
      num_images: 1,
      enable_safety_checker: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `fal.ai повернув помилку ${res.status}: ${text.slice(0, 500)}`
    );
  }

  const data = (await res.json()) as {
    images?: { url: string; content_type?: string }[];
  };
  const image = data.images?.[0];
  if (!image?.url) {
    throw new Error("fal.ai не повернув зображення у відповіді.");
  }

  const imgRes = await fetch(image.url);
  if (!imgRes.ok) {
    throw new Error(`Не вдалося завантажити зображення з fal.ai (${imgRes.status}).`);
  }
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  return { buffer, contentType: image.content_type ?? "image/jpeg" };
}
