// Генерація СЦЕНАРІЮ ролика через OpenAI: тема + слайди, де кожен слайд має
// текст (рядок для script.txt і субтитрів) і опис зображення (що малювати).
// Це чернетка для власника: він читає її в мінідодатку, за потреби пише
// зауваження й перегенеровує, а після «ОК» сценарій іде у промт на Drive,
// звідки ChatGPT малює фото й пакує архів.
import { readFile } from 'node:fs/promises';

const MODEL = process.env.OPENAI_SCENARIO_MODEL || 'gpt-4o-mini';

async function chatJson(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Не задано OPENAI_API_KEY');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.9,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI: HTTP ${response.status} ${await response.text()}`);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI: порожня відповідь');
  return JSON.parse(content);
}

const RULES = `Ти — сценарист вірусних TikTok-роликів українського каналу «Чи Ви Знали?».

ПРАВИЛА СЦЕНАРІЮ:
• 5–8 слайдів (за замовчуванням 5–6; більше — лише якщо факт справді має кілька кроків).
• Слайд 1 — ГАЧОК: одразу найшокуючий факт/цифра, без розгону, не починай із «ЧИ ЗНАЛИ ВИ».
• Структура: гачок → чому так → кульмінація. Найвражаючу цифру — десь у середині.
• Передостанній слайд — найсмачніша деталь-кульмінація.
• ОСТАННІЙ слайд — рівно текст «А ВИ ЗНАЛИ? ПІДПИСУЙСЯ» (петля: на автоповторі
  зчитується разом із гачком).
• text кожного слайда: ВЕЛИКИМИ ЛІТЕРАМИ, до 7 слів, завершена зрозуміла думка.
  Усі слайди підряд читаються як одна зв'язна історія. Цей текст і озвучують, і
  показують на екрані.
• image — детальний опис КАРТИНКИ для цього слайда: реалістична, кінематографічна,
  вертикальна 9:16, у єдиному стилі серії, БЕЗ жодного тексту на зображенні;
  верхні 40% кадру візуально спокійні (туди ляже напис).
• ДОСТОВІРНІСТЬ: факт має бути правдивим і перевіреним; ніяких міфів.`;

function parseSlides(raw) {
  const slides = (raw?.slides || [])
    .map((s) => ({
      text: String(s?.text ?? '').trim(),
      image: String(s?.image ?? '').trim(),
    }))
    .filter((s) => s.text);
  if (slides.length < 3) throw new Error('OpenAI повернув замало слайдів');
  return slides;
}

// Новий сценарій. usedTitles — теми, які вже були (щоб не повторюватись).
export async function generateScenario(usedTitles = []) {
  const used = usedTitles.length ? usedTitles.slice(-40).join('; ') : 'поки немає';
  const raw = await chatJson(`${RULES}

Придумай ОДНУ нову тему (несподіваний правдивий факт із конкретною цифрою;
плюс, якщо пов'язана з Україною) і повний сценарій до неї.

ЗАБОРОНЕНІ теми (вже були): ${used}

Поверни JSON рівно такої форми:
{"theme":"тема одним рядком","slides":[{"text":"ТЕКСТ СЛАЙДА","image":"опис зображення"}]}`);
  return { theme: String(raw?.theme ?? '').trim(), slides: parseSlides(raw) };
}

// Правка наявного сценарію за зауваженнями власника (тема лишається, якщо
// зауваження не просять іншого).
export async function reviseScenario(draft, notes) {
  const raw = await chatJson(`${RULES}

Ось наявний сценарій ролика:
ТЕМА: ${draft.theme}
${draft.slides.map((s, i) => `${i + 1}. ТЕКСТ: ${s.text}\n   ЗОБРАЖЕННЯ: ${s.image}`).join('\n')}

ЗАУВАЖЕННЯ ВЛАСНИКА (виконай їх точно, решту не ламай):
${notes}

Поверни виправлений сценарій у JSON рівно такої форми:
{"theme":"тема одним рядком","slides":[{"text":"ТЕКСТ СЛАЙДА","image":"опис зображення"}]}`);
  return { theme: String(raw?.theme ?? draft.theme).trim(), slides: parseSlides(raw) };
}

// Готовий промт для ChatGPT: правила з prompt.template.txt + УЖЕ затверджений
// сценарій. Власник тисне «ОК» — файл лягає на Drive, ChatGPT його копіює,
// малює фото за описами й пакує архів.
export async function buildPromptText(draft, rowId = '') {
  let template = '';
  try {
    template = await readFile(new URL('../prompt.template.txt', import.meta.url), 'utf8');
    template = template.replaceAll('{{TEMA}}', draft.theme);
  } catch {
    template = '';
  }
  const n = draft.slides.length;
  const scenario = draft.slides
    .map((s, i) => `Фото ${i + 1}\nТекст: ${s.text}\nЗображення: ${s.image}`)
    .join('\n\n');

  return `ЗАТВЕРДЖЕНИЙ СЦЕНАРІЙ — малюй рівно за ним (тексти НЕ змінюй).

ТЕМА: ${draft.theme}
Кількість фото: ${n}

${scenario}

═══════════════════════════════════════
ЩО ЗРОБИТИ:
1. Знайди в інтернеті реальні фото-референси об'єктів теми й вивчи їх.
2. Згенеруй УСІ ${n} зображень 9:16 ОДРАЗУ, в одному стилі, реалістичні,
   ЧИСТІ БЕЗ ТЕКСТУ (написи накладе застосунок).
3. Підготуй ЗВЕДЕНУ КАРТИНКУ — сітку з підписами 1…${n} (для перегляду оком).
4. Підготуй АРХІВ .zip: рівно ${n} фото «1.jpg»…«${n}.jpg» (повна якість,
   порядок сценарію) + «script.txt» — тексти слайдів ПО ОДНОМУ РЯДКУ НА ФОТО
   (рядок 1 → 1.jpg, …), без описів і розмітки. Жодних інших файлів.
5. Завантаж ZIP у папку Google Drive.
6. ОНОВИ ЦЕЙ САМИЙ РЯДОК у таблиці «Черга тем»${rowId ? ` (ID: ${rowId})` : ''} —
   НЕ створюй новий:
   • «Архів» — посилання на ZIP;
   • «Назва публікації» — заголовок для соцмереж;
   • «Опис для соцмереж» — гачок, пояснення, запитання, заклик підписатись
     і рівно 5 хештегів;
   • «Статус» — зміни з NEW на DONE.
Тему НЕ придумуй — вона вже затверджена вище.

${template ? `═══════════════════════════════════════\nДОВІДКА — стиль каналу:\n\n${template}` : ''}`;
}
