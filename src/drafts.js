// Чернетки сценаріїв на Google Drive. Додаток на Railway без стану, тож усі
// чернетки живуть одним JSON-файлом у папці каналу:
//   drafts.json — { items: [ { key, date, slot, theme, slides[], status, notes } ] }
//
// Слоти на добу: 'am' (готуємо з 08:00) і 'pm' (готуємо з 16:00). Власник
// править чернетку в мінідодатку; після «ОК» вона стає РЯДКОМ у таблиці зі
// статусом NEW і промтом у колонці «Додаткові вказівки» — далі ChatGPT за
// відкладеним завданням (16:00 / 20:00) малює фото й пакує архів.
import { drive } from './drive.js';
import { buildPromptText } from './scenario.js';
import { appendQueueRow } from './sheets.js';

const FOLDER_ID = process.env.PROMPT_FOLDER_ID || '1GiHg-j0ytQyfjLU97i5vkXL6XfjIR9Uk';
const FILE_NAME = 'drafts.json';
const KEEP = 8; // скільки останніх чернеток тримати у файлі

export function promptFolderId() { return FOLDER_ID; }

// Дата в Києві як YYYY-MM-DD.
export function kyivToday(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export function kyivMinutes(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  return Number(p.find((x) => x.type === 'hour').value) * 60
    + Number(p.find((x) => x.type === 'minute').value);
}

// Слоти підготовки: ранковий — з 08:00, вечірній — з 16:00 (Київ).
export const SLOT_AM_MIN = Number(process.env.DRAFT_AM_MINUTES) || 8 * 60;
export const SLOT_PM_MIN = Number(process.env.DRAFT_PM_MINUTES) || 16 * 60;

// Який слот вже настав (готуємо чернетку). До 08:00 — нічого.
export function currentSlot(now = new Date()) {
  const m = kyivMinutes(now);
  if (m >= SLOT_PM_MIN) return 'pm';
  if (m >= SLOT_AM_MIN) return 'am';
  return null;
}

async function findFile() {
  const res = await drive().files.list({
    q: `'${FOLDER_ID}' in parents and name = '${FILE_NAME}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function writeAll(items) {
  const body = JSON.stringify({ items: items.slice(-KEEP) }, null, 2);
  const media = { mimeType: 'application/json', body };
  const existing = await findFile();
  if (existing) await drive().files.update({ fileId: existing, media, supportsAllDrives: true });
  else {
    await drive().files.create({
      requestBody: { name: FILE_NAME, parents: [FOLDER_ID] },
      media, fields: 'id', supportsAllDrives: true,
    });
  }
  return items;
}

// Усі збережені чернетки (найновіші в кінці).
export async function listDrafts() {
  const id = await findFile();
  if (!id) return [];
  const res = await drive().files.get({ fileId: id, alt: 'media', supportsAllDrives: true });
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  return Array.isArray(data?.items) ? data.items : [];
}

// Чернетки, які ще чекають на затвердження.
export async function pendingDrafts() {
  return (await listDrafts()).filter((d) => d.status === 'pending');
}

export async function findDraft(key) {
  return (await listDrafts()).find((d) => d.key === key) ?? null;
}

// Створити/замінити чернетку за ключем.
export async function upsertDraft(draft) {
  const items = await listDrafts();
  const i = items.findIndex((d) => d.key === draft.key);
  if (i >= 0) items[i] = draft; else items.push(draft);
  await writeAll(items);
  return draft;
}

export async function removeDraft(key) {
  const items = (await listDrafts()).filter((d) => d.key !== key);
  await writeAll(items);
}

// ID рядка в таблиці: AUTO-YYYYMMDD-0800 / -1600 (як наявні AUTO-…).
function rowId(draft) {
  const ymd = (draft.date || kyivToday()).replace(/-/g, '');
  return `AUTO-${ymd}-${draft.slot === 'pm' ? '1600' : '0800'}`;
}

// «ОК»: кладемо рядок у таблицю (статус NEW + промт у колонці «Додаткові
// вказівки»), а чернетку прибираємо зі списку. ChatGPT візьме цей рядок за
// відкладеним завданням і згенерує фото/архів.
export async function approveDraft(draft) {
  const id = rowId(draft);
  const prompt = await buildPromptText(draft, id);
  await appendQueueRow({
    id,
    theme: draft.theme,
    slides: draft.slides.length,
    prompt,
    note: 'Сценарій затверджено власником; малювати рівно за промтом',
  });
  await removeDraft(draft.key);
  return { id, slides: draft.slides.length };
}
