// Точка входу воркфлоу themes: 10:00 та 18:00 (Київ) — нова тема + промпт власнику.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { generateTheme } from './openai.js';
import { FACTS_POOL, remainingFacts } from './facts-pool.js';
import { ownerChatId, sendMessage } from './telegram.js';
import {
  currentCarouselSlot,
  currentThemeSlot,
  emptySession,
  kyivDate,
  markTheme,
  readState,
  saveState,
} from './state.js';

const LOW_POOL_THRESHOLD = 10;

const WINDOW_HOURS = 3;

// Спільна логіка для themes.js і check.js (кнопка «Інша тема»):
// генерує тему, надсилає промпт із кнопкою, відкриває нову сесію в state.
export async function startNewSession(state) {
  // Заборонені: done (уже використані) і rejected (власнику не сподобались).
  // pending/skipped можуть випасти знову — тема пропала не з вини власника.
  const usedTitles = state.themes
    .filter((theme) => theme.status === 'done' || theme.status === 'rejected')
    .map((theme) => theme.title);
  const theme = await generateTheme(usedTitles);

  // Пул перевірених фактів тане — попереджаємо власника, поки лишається
  // ще кілька, щоб було коли поповнити список (не після того, як скінчиться).
  const left = remainingFacts([...usedTitles, theme]).length;
  if (left > 0 && left <= LOW_POOL_THRESHOLD) {
    await sendMessage(ownerChatId(), `⚠️ У пулі перевірених фактів залишилось ${left}. Час поповнити список!`);
  }

  const template = await readFile(new URL('../prompt.template.txt', import.meta.url), 'utf8');
  const promptText = template.replaceAll('{{TEMA}}', theme);

  const message = await sendMessage(ownerChatId(), promptText, {
    inline_keyboard: [[{ text: '🔄 Інша тема', callback_data: 'other_theme' }]],
  });

  // source фіксує походження факту — прямо в state.json, який бот і так
  // комітить щоразу. Не лише проти повторів (усі done/rejected title і так
  // заборонені незалежно від джерела), а щоб при підборі наступної партії
  // фактів для пулу було видно одним поглядом на history, що з пулу вже
  // пішло в ефір, а що GPT вигадав сам (і теж більше не пропонувати).
  const source = FACTS_POOL.some((fact) => fact.text === theme) ? 'pool' : 'gpt';
  state.themes.push({ title: theme, status: 'pending', date: kyivDate(), source });
  // Мітка слота, щоб запізнілий плановий запуск themes не дублював тему.
  state.last_theme_slot = currentThemeSlot() ?? state.last_theme_slot ?? null;
  state.session = {
    active: true,
    theme,
    prompt_message_id: message.message_id,
    photos: [],
    script: null,
    archive: null,
    window_end: new Date(Date.now() + WINDOW_HOURS * 60 * 60 * 1000).toISOString(),
  };
  return theme;
}

// Фото-карусель (обідній слот): надсилає нову тему з КАРУСЕЛЬНИМ промптом і
// позначає її використаною, але НЕ відкриває відео-сесію — власник генерує
// 6 фото й постить каруселлю в TikTok/Instagram вручну, без озвучки й монтажу.
export async function sendCarouselTheme(state) {
  const usedTitles = state.themes
    .filter((theme) => theme.status === 'done' || theme.status === 'rejected')
    .map((theme) => theme.title);
  const theme = await generateTheme(usedTitles);

  const left = remainingFacts([...usedTitles, theme]).length;
  if (left > 0 && left <= LOW_POOL_THRESHOLD) {
    await sendMessage(ownerChatId(), `⚠️ У пулі перевірених фактів залишилось ${left}. Час поповнити список!`);
  }

  const template = await readFile(new URL('../prompt.carousel.template.txt', import.meta.url), 'utf8');
  await sendMessage(ownerChatId(), `🖼 Тема для фото-каруселі (TikTok + Instagram):`);
  await sendMessage(ownerChatId(), template.replaceAll('{{TEMA}}', theme));

  const source = FACTS_POOL.some((fact) => fact.text === theme) ? 'pool' : 'gpt';
  // status 'done' — щоб тема не повторювалась; kind фіксує, що це карусель.
  state.themes.push({ title: theme, status: 'done', date: kyivDate(), source, kind: 'carousel' });
  return theme;
}

async function main() {
  const state = await readState();

  // Обідній слот — фото-карусель (окремо від відео-тем, без відео-сесії).
  const carouselSlot = currentCarouselSlot();
  if (carouselSlot) {
    if (state.last_carousel_slot === carouselSlot) return; // вже надіслано цього слота
    const theme = await sendCarouselTheme(state);
    state.last_carousel_slot = carouselSlot;
    await saveState(state, `themes: тема каруселі «${theme}»`);
    return;
  }

  // Тему цього слота вже надіслано (можливо, self-healing у check.js) —
  // запізнілий плановий запуск не має дублювати її.
  const slot = currentThemeSlot();
  if (slot && state.last_theme_slot === slot) return;

  // GitHub інколи затримує плановий запуск на години — якщо він фактично
  // виконався вже поза вікном теми (10:00–12:00 / 18:00–20:00 Київ),
  // не створювати «фантомну» тему в неурочний час. Наступний реальний
  // слот підхопить усе сам (check.js self-healing або наступний themes.yml).
  if (!slot) {
    console.log('Поза вікном теми (плановий запуск сильно затримався) — пропускаю.');
    return;
  }

  if (state.session.active) {
    markTheme(state, state.session.theme, 'skipped');
    state.session = emptySession();
    await sendMessage(ownerChatId(), 'Попередня сесія пропущена');
  }

  const theme = await startNewSession(state);
  await saveState(state, `themes: нова тема «${theme}»`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
