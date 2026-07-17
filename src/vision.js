// Vision-перевірка слайдів через OpenAI (gpt-4o-mini) — ЧЕРНЕТКА за флагом.
// Мета: після розпакування архіву від власника переконатися, що кожне фото
// придатне — текст у безпечній зоні, читабельно, а слайд відповідає своєму
// номеру (щоб зловити, якщо ШІ підсунув чуже фото). ~$0.003–0.005 за фото.
//
// Дешева частина (звірка імен, валідність файлу) робиться БЕЗ AI у web/
// server.js. Сюди приходить лише змістова перевірка, і лише коли задано
// ENABLE_PHOTO_CHECK=1 — інакше checkSlide() одразу повертає ok.
import { readFile } from 'node:fs/promises';

const MODEL = 'gpt-4o-mini';

// Перевіряє одне фото. expectedText — рядок(и) слайда зі сценарію (може бути
// порожнім, тоді перевіряємо лише безпечні зони й читабельність).
// Повертає { ok:boolean, issue:string|null }.
export async function checkSlide(imagePath, expectedText = '') {
  if (process.env.ENABLE_PHOTO_CHECK !== '1') return { ok: true, issue: null };
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: true, issue: null };

  const base64 = (await readFile(imagePath)).toString('base64');
  const expectPart = expectedText
    ? `Очікуваний текст цього слайда: «${expectedText}». Перевір, чи видимий текст на фото відповідає йому за змістом.`
    : 'Тексту-еталона немає — перевіряй лише зони й читабельність.';
  const prompt = `Ти — контролер якості слайдів вертикального (9:16) TikTok-відео.
${expectPart}
Також перевір безпечні зони: текст лише у верхніх 40% кадру; нижні 25%
чисті (там TikTok показує опис і музику); правий край (15%) без підписів.
Відповідь — строго JSON: {"ok": true/false, "issue": "коротко що не так, або порожньо"}.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) {
    // Перевірка не критична — не блокуємо монтаж, лише лишаємо слід у логах.
    console.error(`Vision-перевірка: HTTP ${response.status}`);
    return { ok: true, issue: null };
  }
  const data = await response.json();
  try {
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
    return { ok: parsed.ok !== false, issue: parsed.ok === false ? String(parsed.issue || 'проблема') : null };
  } catch {
    return { ok: true, issue: null };
  }
}

// Перевіряє всі слайди по черзі. slideTexts — масив очікуваних текстів у
// порядку фото (може бути коротшим/порожнім). Повертає масив
// { index, ok, issue } лише для проблемних (порожній масив = все гаразд).
export async function checkSlides(photoPaths, slideTexts = []) {
  const problems = [];
  for (const [index, photoPath] of photoPaths.entries()) {
    const { ok, issue } = await checkSlide(photoPath, slideTexts[index] || '');
    if (!ok) problems.push({ index: index + 1, ok, issue });
  }
  return problems;
}
