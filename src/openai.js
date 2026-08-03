// OpenAI: генерація теми (воркфлоу themes) і текстів публікації (воркфлоу check).
import { slideshowDuration } from './montage.js';

const MODEL = 'gpt-4o-mini';

async function chat(prompt, options = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Не задано змінну середовища OPENAI_API_KEY');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      ...options,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI: HTTP ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI: порожня відповідь');
  return content.trim();
}

// Один запит до моделі без обгорток — для відповідей на коментарі.
export function chatOnce(prompt, options = {}) {
  return chat(prompt, options);
}

// Текст озвучки для відео (використовується лише коли ENABLE_TTS=1).
// Якщо власник надіслав сценарій слайдів (script) — озвучка складається
// з текстів слайдів; інакше — генерується за темою.
// slideCount — фактична кількість слайдів (5–8): від неї залежить довжина
// відео й, отже, бюджет символів/слів озвучки, щоб вона точно вмістилась.
export async function generateNarration(theme, script, slideCount = 6) {
  // Головний шлях — озвучити ТЕКСТИ СЛАЙДІВ з архіву майже дослівно, щоб голос
  // збігався з тим, що написано на екрані. Без архіву (лише тема) — скласти
  // начитку з нуля (запасний випадок).
  if (script) return narrateFromSlides(script, slideCount);
  return narrateFromTheme(theme, slideCount);
}

// Скільки слів на всю начитку, щоб відео вклалось у ~MAX_VIDEO_SECONDS на
// швидкості 1.4× (без прискорення дикції). Рахунок від довжини відео:
// video = аудіо_після_темпу + fade + pad*slideCount; аудіо_після_темпу =
// сирі_секунди/1.4; сирі_секунди = слова/темп_мовлення.
function slideNarrationWordCap(slideCount) {
  const TARGET_VIDEO = 27; // ціль із невеликим буфером під жорсткі 29 с
  const FADE = 0.5, PAD = 0.5, SPEECH_RATE = 2.1; // слів/с (укр. голос читає жваво)
  const TEMPO = Number(process.env.TTS_ALIGN_TEMPO) || 1.0; // синхронно з tts.js
  const overhead = FADE + PAD * slideCount;
  const audioAfterTempo = Math.max(6, TARGET_VIDEO - overhead);
  return Math.max(slideCount * 3, Math.round(audioAfterTempo * TEMPO * SPEECH_RATE));
}

// Озвучує тексти слайдів МАЙЖЕ ДОСЛІВНО (голос = напис на слайді), адаптуючи
// лише для читання вголос (числа словами, природна вимова). Одне речення на слайд.
// Скорочує ЛИШЕ за потреби (щоб відео ≤ ~29 с) — мінімально, не прискорюючи темп.
async function narrateFromSlides(script, slideCount) {
  const maxWords = slideNarrationWordCap(slideCount);
  const prompt = `Ти — диктор українського TikTok-каналу «Чи Ви Знали?».
Ось тексти слайдів (по одному рядку на слайд). Озвуч КОЖЕН слайд його текстом —
рівно по одному реченню на слайд (${slideCount} речень), у тому ж порядку й змісті.
НАЙВАЖЛИВІШЕ: тримайся МАКСИМАЛЬНО близько до оригінального тексту слайда —
майже дослівно. Адаптуй лише для читання ВГОЛОС:
• числа й цифри — СЛОВАМИ та в називному відмінку («215» → «двісті п'ятнадцять»);
• прибери ВЕЛИКІ літери, зроби природне речення;
• якщо номер стоїть із власною назвою — без відмінювання назви за числівником.
ДОВЖИНА: разом НЕ більше ${maxWords} слів. Якщо трохи не вкладаєшся — прибери
ЛИШЕ 1–2 зайвих слова В НАЙДОВШИХ реченнях (напр. «справжні», «саме»,
«фізично», «завдяки цьому»). НЕ переписуй, НЕ спрощуй, НЕ скорочуй короткі
речення — кожен факт і всі числа лишаються. НЕ прискорюй темп — просто трохи
менше слів там, де довго.
Останній слайд (напр. «А ВИ ЗНАЛИ?») озвуч рівно як «А ви знали?». Службові
підписи типу «підписуйся» НЕ озвучуй.
У рідкісних словах з неочевидним наголосом познач наголос комбінованим акутом
U+0301 (напр. колі́брі). Без емодзі, лапок і нумерації — лише суцільний текст,
речення через крапку.
Тексти слайдів:
${script}`;
  const narration = await chat(prompt, { temperature: 0.2 });
  // М'який backstop: якщо все одно задовге — прибрати кілька слів, максимально
  // зберігши оригінал (без агресивного переписування).
  const trimmed = await trimGently(narration, maxWords, slideCount);
  return enforceSentenceCount(trimmed, slideCount);
}

// Обережно скорочує НАДЛИШОК (лише якщо помітно за лімітом), прибираючи кілька
// слів і зберігаючи оригінальні речення й числа. Без переписування.
async function trimGently(text, maxWords, slideCount) {
  if (text.trim().split(/\s+/).filter(Boolean).length <= Math.round(maxWords * 1.08)) return text;
  const prompt = `Цей текст озвучки трохи задовгий. Скороти його до НЕ більше ${maxWords}
слів, прибравши ЛИШЕ кілька зайвих слів (зв'язки, повтори) у найдовших реченнях.
МАКСИМАЛЬНО збережи оригінальні речення, кожен факт і ВСІ числа. Не переписуй і
не спрощуй. Залиш рівно ${slideCount} речень, останнє — «А ви знали?». Лише текст:

${text}`;
  try {
    const shorter = await chat(prompt, { temperature: 0.2 });
    return shorter.split('\n').filter((l) => l.trim()).join(' ').trim() || text;
  } catch (error) {
    console.error('Не вдалося м’яко скоротити начитку:', error.message);
    return text;
  }
}

// Складає начитку з нуля за темою (коли сценарію/архіву нема): гачок-твердження,
// деталі, петля-питання «А ви знали?». Тут бюджет довжини має значення.
async function narrateFromTheme(theme, slideCount) {
  const videoSeconds = Math.round(slideshowDuration(slideCount));
  const charLimit = Math.round(slideCount * 50);
  const minWords = Math.round(slideCount * 6.0);
  const maxWords = Math.round(slideCount * 7.2);
  const prompt = `Ти — диктор українського TikTok-каналу «Чи Ви Знали?».
Тема ролика: ${theme}
Напиши текст озвучки для відео з ${slideCount} слайдів (разом ~${videoSeconds} с).
Вимоги:
- ПО СЛАЙДАХ: рівно ОДНЕ коротке речення на кожен слайд (${slideCount} речень), усі
  приблизно однакової довжини (~6 слів); разом ${minWords}–${maxWords} слів, не більше
  ${charLimit} символів.
- ГАЧОК (перше речення) — сильний зачин-ТВЕРДЖЕННЯ про предмет, без «Чи знали ви…».
- КІНЦІВКА (останнє речення) — фірмове питання «А ви знали?»; на автоповторі
  зливається з гачком у «А ви знали? [гачок]».
- ЧИСЛА — словами й у називному відмінку («тридцять дев'ять», не «39»).
- Чітко назви предмет повним словом; без емодзі, лапок і нумерації.
- У рідкісних словах з неочевидним наголосом — акут U+0301 (колі́брі).
НЕ вимовляй «підписуйся».`;
  const narration = await chat(prompt, { temperature: 0.4 });
  const budgeted = await enforceWordBudget(narration, maxWords);
  return enforceSentenceCount(budgeted, slideCount);
}

// Розбиває на речення (та сама логіка, що в tts.js) — для звірки кількості.
function splitIntoSentences(text) {
  const matches = text.replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]+/g);
  return (matches || [text.trim()]).map((s) => s.trim()).filter(Boolean);
}

// Начитка мусить мати РІВНО по реченню на слайд, інакше tts не зможе
// прив'язати її до слайдів. Якщо кількість не збіглась — один раз просимо
// GPT переписати рівно потрібною кількістю речень.
async function enforceSentenceCount(text, slideCount) {
  if (splitIntoSentences(text).length === slideCount) return text;
  const prompt = `Перепиши цей текст озвучки РІВНО ${slideCount} реченнями — по одному
короткому реченню (~6 слів) на кожен слайд, у тому ж порядку й змісті, ВСІ
приблизно однакової довжини. Перше — сильний зачин-твердження; ОСТАННЄ (${slideCount}-е)
речення — рівно «А ви знали?». Не додавай нічого нового, НЕ згадуй підписку.
Числа — словами. Відповідь — лише текст:

${text}`;
  try {
    const fixed = await chat(prompt, { temperature: 0.3 });
    const joined = fixed.split('\n').filter((l) => l.trim()).join(' ').trim();
    return splitIntoSentences(joined).length === slideCount ? joined : text;
  } catch (error) {
    console.error('Не вдалося вирівняти кількість речень:', error.message);
    return text;
  }
}

// Рахує слова; якщо помітно більше за ліміт — одним викликом просить GPT
// стиснути текст, зберігши суть, гачок і петлю. Токенів це майже не коштує.
async function enforceWordBudget(text, maxWords) {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount <= Math.round(maxWords * 1.15)) return text;
  const prompt = `Скороти цей текст озвучки до НЕ більше ${maxWords} слів: рівно по
одному короткому реченню на кожну думку (слайд) у тому ж порядку, ВСІ речення
приблизно однакової довжини (~6 слів кожне). Перше — сильний зачин-твердження.
Останнє — фірмове питання «А ви знали?» (щоб на повторі злилось із першим
реченням у «А ви знали? [перше речення]»). Не додавай нічого нового, НЕ згадуй
підписку. Числа — словами. Лише текст:

${text}`;
  try {
    const shorter = await chat(prompt, { temperature: 0.3 });
    return shorter.split('\n').filter((l) => l.trim()).join(' ').trim() || text;
  } catch (error) {
    console.error('Не вдалося стиснути начитку, лишаю як є:', error.message);
    return text;
  }
}

export async function generatePostTexts(theme) {
  const prompt = `Ти — SMM українського TikTok-каналу «Чи Ви Знали?» (пізнавальні факти).
Тема сьогоднішнього ролика: ${theme}
Згенеруй тексти для публікації. Відповідь — строго JSON:
{
  "title": "чіпляюча назва до 60 символів з 1 емодзі",
  "description": "опис за форматом нижче",
  "hashtags": "рівно 5 хештегів українською в один рядок",
  "music": "3 варіанти музики під це відео з каталогу TikTok, кожен з нового рядка у форматі: 1. Назва треку — виконавець (чому пасує, 3–5 слів). Обирай популярні/вірусні в TikTok звуки, що підходять під настрій теми: інтригуючі, епічні або атмосферні."
}

Формат description — 4 абзаци, розділені порожнім рядком, кожен з емодзі:
1. Хук: тематичне емодзі + інтригуюче питання «Чи знали ви, що …?» + 😲
2. Найвражаюча деталь факту одним-двома реченнями (з цифрою чи порівнянням, можна з емодзі).
3. Питання-залучення до глядача, наприклад «А ви знали про це? 👇»
4. Заклик: «Підписуйся, щоб не пропустити нові неймовірні факти! 🧠✨» (можна варіювати формулювання та емодзі).

Приклад description:
🍯 Чи знали ви, що мед може залишатися їстівним тисячі років? 😲

Археологи знаходили мед у єгипетських гробницях, і він не зіпсувався навіть через понад 3000 років!

А ви знали про це? 👇

Підписуйся, щоб не пропустити нові неймовірні факти! 🧠✨`;
  const raw = await chat(prompt, { response_format: { type: 'json_object' } });
  const parsed = JSON.parse(raw);
  for (const field of ['title', 'description', 'hashtags']) {
    if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
      throw new Error(`OpenAI: у відповіді немає поля «${field}»`);
    }
  }
  return {
    title: parsed.title.trim(),
    description: parsed.description.trim(),
    hashtags: parsed.hashtags.trim(),
    // Музика — допоміжна порада, без неї публікація не блокується.
    music: typeof parsed.music === 'string' && parsed.music.trim() ? parsed.music.trim() : null,
  };
}
