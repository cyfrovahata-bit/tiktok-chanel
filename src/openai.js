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

export async function generatePostTexts(theme) {
  const prompt = `Ти — SMM українського TikTok-каналу «Чи Ви Знали?» (пізнавальні факти).
Тема сьогоднішнього ролика: ${theme}
Згенеруй тексти для публікації. Відповідь — строго JSON:
{
  "title": "чіпляюча назва до 60 символів з 1 емодзі",
  "description": "2–3 речення для TikTok/Shorts із закликом додивитись",
  "hashtags": "5–6 хештегів українською в один рядок"
}`;
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
  };
}
