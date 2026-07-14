// OpenAI: генерація теми (воркфлоу themes) і текстів публікації (воркфлоу check).
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

export async function generateTheme(usedTitles) {
  const prompt = `Ти — контент-директор українського TikTok-каналу «Чи Ви Знали?».
Придумай ОДНУ нову тему для короткого факт-ролика.
Вимоги: несподіваний правдивий факт без міфів; його можна показати
візуально (розріз, порівняння розмірів, процес); категорії чергуй
(тварини, космос, тіло людини, фізика, історія, їжа, океан, технології).
ЗАБОРОНЕНІ теми (вже використані): ${usedTitles.length ? usedTitles.join('; ') : 'поки немає'}
Відповідь — лише формулювання теми одним рядком, без лапок і пояснень.`;
  const theme = await chat(prompt, { temperature: 1 });
  // На випадок, якщо модель усе ж загорнула тему в лапки.
  return theme.split('\n')[0].replace(/^["«»']+|["«»']+$/g, '').trim();
}

// Текст озвучки для відео (використовується лише коли ENABLE_TTS=1).
// Якщо власник надіслав сценарій слайдів (script) — озвучка складається
// з текстів слайдів; інакше — генерується за темою.
export async function generateNarration(theme, script) {
  const source = script
    ? `Ось сценарій слайдшоу (тексти 6 фото). Склади озвучку САМЕ з текстів
слайдів: збережи їх порядок і формулювання, лише з'єднай у зв'язну розповідь
і додай сполучники, де треба.
Сценарій:
${script}`
    : `Тема ролика: ${theme}
Починається з «Чи знали ви, що …», далі 2–3 найвражаючі деталі факту
(цифри, порівняння), передостаннє речення починається з «Саме тому …»,
останнє — короткий заклик підписатися.`;
  // Для ElevenLabs v3 текст збагачується аудіо-тегами — вони не читаються
  // вголос, а керують грою голосу (для інших рушіїв теги вирізаються в tts.js).
  const audioTags =
    process.env.TTS_ENGINE === 'elevenlabs'
      ? `
Додай 3–4 аудіо-теги у квадратних дужках англійською перед фразами,
де це доречно: [excited] для хука, [whispers] для інтриги,
[impressed] чи [curious] для вражаючих цифр. Теги керують емоціями
голосу і не озвучуються.`
      : '';
  const prompt = `Ти — диктор українського TikTok-каналу «Чи Ви Знали?».
${source}
Напиши текст озвучки для 21-секундного відео: 45–55 слів, жива розмовна
українська. Без емодзі, без лапок, без заголовків і нумерації —
лише суцільний текст для читання вголос.${audioTags}`;
  return chat(prompt, { temperature: 0.9 });
}

export async function generatePostTexts(theme) {
  const prompt = `Ти — SMM українського TikTok-каналу «Чи Ви Знали?» (пізнавальні факти).
Тема сьогоднішнього ролика: ${theme}
Згенеруй тексти для публікації. Відповідь — строго JSON:
{
  "title": "чіпляюча назва до 60 символів з 1 емодзі",
  "description": "опис за форматом нижче",
  "hashtags": "5–6 хештегів українською в один рядок",
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
