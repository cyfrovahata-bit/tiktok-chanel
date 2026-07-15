// Ручний рерол активної теми — той самий ефект, що й натискання «Інша
// тема» в Telegram, але з коду (наприклад, коли власник просить замінити
// тему через чат, а не з телефону). Запуск: Actions → reroll → Run workflow.
import { editMessageReplyMarkup, ownerChatId } from '../src/telegram.js';
import { emptySession, markTheme, readState, saveState } from '../src/state.js';
import { startNewSession } from '../src/themes.js';

const state = await readState();

if (!state.session.active) {
  console.log('Немає активної сесії — нічого реролити.');
  process.exit(0);
}

try {
  await editMessageReplyMarkup(ownerChatId(), state.session.prompt_message_id);
} catch (error) {
  console.error('Не вдалося прибрати кнопку зі старого промпта:', error.message);
}

const oldTheme = state.session.theme;
markTheme(state, oldTheme, 'rejected');
state.session = emptySession();
const theme = await startNewSession(state);
await saveState(state, `reroll: «${oldTheme}» замінено на «${theme}»`);
console.log(`Замінено: «${oldTheme}» -> «${theme}»`);
