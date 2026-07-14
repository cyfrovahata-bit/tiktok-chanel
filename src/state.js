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

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export async function saveState(state, commitMessage) {
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  // Поза GitHub Actions (локальний дебаг) файл пишемо, але не комітимо.
  if (process.env.GITHUB_ACTIONS !== 'true') return;

  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git('add', 'state.json');
  if (!git('status', '--porcelain', 'state.json').trim()) return;
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
