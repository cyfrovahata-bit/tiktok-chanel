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
const REJECTED_KEEP = 60; // скільки відхилених тем пам'ятати (щоб не повторювати)

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

// Записує документ цілком: чернетки (останні KEEP) + відхилені теми.
async function writeAll(input) {
  const doc = {
    items: (input.items || []).slice(-KEEP),
    rejected: (input.rejected || []).slice(-REJECTED_KEEP),
  };
  const media = { mimeType: 'application/json', body: JSON.stringify(doc, null, 2) };
  const existing = await findFile();
  if (existing) await drive().files.update({ fileId: existing, media, supportsAllDrives: true });
  else {
    await drive().files.create({
      requestBody: { name: FILE_NAME, parents: [FOLDER_ID] },
      media, fields: 'id', supportsAllDrives: true,
    });
  }
  return doc;
}

// Увесь документ: чернетки + відхилені теми.
async function readDoc() {
  const id = await findFile();
  if (!id) return { items: [], rejected: [] };
  const res = await drive().files.get({ fileId: id, alt: 'media', supportsAllDrives: true });
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    rejected: Array.isArray(data?.rejected) ? data.rejected : [],
  };
}

// Усі збережені чернетки (найновіші в кінці).
export async function listDrafts() {
  return (await readDoc()).items;
}

// Теми, які власник відхилив («Інша тема» або «Прибрати») — більше не пропонуємо.
export async function listRejectedThemes() {
  return (await readDoc()).rejected;
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
  const doc = await readDoc();
  const i = doc.items.findIndex((d) => d.key === draft.key);
  if (i >= 0) doc.items[i] = draft; else doc.items.push(draft);
  await writeAll(doc);
  return draft;
}

// Прибирає чернетку й ЗАПАМ'ЯТОВУЄ її тему як відхилену, щоб генератор більше
// не пропонував те саме.
export async function rejectDraft(key) {
  const doc = await readDoc();
  const gone = doc.items.find((d) => d.key === key);
  doc.items = doc.items.filter((d) => d.key !== key);
  if (gone?.theme && !doc.rejected.includes(gone.theme)) doc.rejected.push(gone.theme);
  await writeAll(doc);
  return gone?.theme ?? null;
}

export async function removeDraft(key) {
  const doc = await readDoc();
  doc.items = doc.items.filter((d) => d.key !== key);
  await writeAll(doc);
}

// ID рядка в таблиці: AUTO-YYYYMMDD-0800 / -1600 (як наявні AUTO-…).
export function draftRowId(draft) { return rowId(draft); }
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
  // Чернетку НЕ видаляємо, а позначаємо затвердженою: інакше слот став би
  // «вільним» і монітор наступним проходом згенерував би нову тему на сьогодні.
  // У мінідодатку вона зникає, бо pendingDrafts() бере лише status='pending'.
  await upsertDraft({ ...draft, status: 'approved', rowId: id, approvedAt: new Date().toISOString() });
  return { id, slides: draft.slides.length };
}
