// Читання/запис state.json і його коміт назад у репозиторій —
// це єдине «сховище» бота між запусками воркфлоу.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const STATE_FILE = path.resolve('state.json');
const PUSH_ATTEMPTS = 3;

export async function readState() {
  return JSON.parse(await readFile(STATE_FILE, 'utf8'));
}

export function emptySession() {
  return {
    active: false,
    theme: null,
    prompt_message_id: null,
    photos: [],
    script: null,
    window_end: null,
  };
}

// Оновлює статус найсвіжішого запису теми з таким title.
export function markTheme(state, title, status) {
  for (let i = state.themes.length - 1; i >= 0; i--) {
    if (state.themes[i].title === title) {
      state.themes[i].status = status;
      return;
    }
  }
}

export function kyivDate() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
}

// Слот теми: ранковий (10:00–12:59 Київ) чи вечірній (18:00–20:59), інакше null.
// Буфер — ті самі 3 години, що й вікно прийому фото (WINDOW_HOURS), щоб
// затриманий на години плановий запуск ще міг наздогнати слот, але
// справді неурочний час (глибока ніч) лишався заблокованим.
export function currentThemeSlot(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false })
      .formatToParts(now)
      .find((part) => part.type === 'hour').value,
  );
  if (hour >= 10 && hour < 13) return `${kyivDate()}-am`;
  if (hour >= 18 && hour < 21) return `${kyivDate()}-pm`;
  return null;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// extraPaths — додаткові файли/директорії для коміту разом зі state.json
// (наприклад, last-video/ — знімок останнього змонтованого відео для
// подальшої перегенерації без повторного надсилання фото від власника).
export async function saveState(state, commitMessage, extraPaths = []) {
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  // Поза GitHub Actions (локальний дебаг) файл пишемо, але не комітимо.
  if (process.env.GITHUB_ACTIONS !== 'true') return;

  const paths = ['state.json', ...extraPaths];
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git('add', ...paths);
  if (!git('status', '--porcelain', ...paths).trim()) return;
  git('commit', '-m', commitMessage);

  // Два воркфлоу можуть писати state.json одночасно: перед пушем підтягуємо
  // чужі коміти. Під час rebase «theirs» — це наш коміт, тож при конфлікті
  // state.json перемагає щойно обчислений стан.
  for (let attempt = 1; ; attempt++) {
    try {
      git('pull', '--rebase', '-X', 'theirs');
      git('push');
      return;
    } catch (error) {
      try {
        git('rebase', '--abort');
      } catch {
        // rebase міг і не початися — це не помилка
      }
      if (attempt >= PUSH_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}
