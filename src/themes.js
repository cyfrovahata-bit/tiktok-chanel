// Точка входу воркфлоу themes: 11:00 та 19:00 (Київ) — нова тема + промпт власнику.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { generateTheme } from './openai.js';
import { ownerChatId, sendMessage } from './telegram.js';
import { emptySession, kyivDate, markTheme, readState, saveState } from './state.js';

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

  const template = await readFile(new URL('../prompt.template.txt', import.meta.url), 'utf8');
  const promptText = template.replaceAll('{{TEMA}}', theme);

  const message = await sendMessage(ownerChatId(), promptText, {
    inline_keyboard: [[{ text: '🔄 Інша тема', callback_data: 'other_theme' }]],
  });

  state.themes.push({ title: theme, status: 'pending', date: kyivDate() });
  state.session = {
    active: true,
    theme,
    prompt_message_id: message.message_id,
    photos: [],
    window_end: new Date(Date.now() + WINDOW_HOURS * 60 * 60 * 1000).toISOString(),
  };
  return theme;
}

async function main() {
  const state = await readState();

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
