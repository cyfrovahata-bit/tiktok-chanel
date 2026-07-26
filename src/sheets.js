// Читання/запис Google Sheet «Черга тем» — головне джерело стану.
// ChatGPT (зовнішня автоматизація) пише рядки й ставить статус DONE.
// Додаток лише ЧИТАЄ готові матеріали й, після публікації користувачем,
// переводить рядок DONE → PUBLISHED. Він НЕ вигадує теми, НЕ змінює
// назву/опис і НЕ чіпає PROCESSING/ERROR.
import { google } from 'googleapis';
import { googleAuth } from './google-auth.js';

const SHEET_ID = process.env.SHEET_ID || '1-cH52PtmicqEWc-6BegDpgO6bbbOwjB8W3rPrr4boHA';
const TAB = process.env.SHEET_TAB || 'Черга тем';
const RANGE = `${TAB}!A:N`;

// Порядок колонок за домовленістю (A..N).
const COL = {
  id: 0, category: 1, theme: 2, pubDate: 3, status: 4, slides: 5,
  extra: 6, archive: 7, created: 8, processed: 9, sources: 10,
  note: 11, title: 12, description: 13,
};

let sheetsApi = null;
function api() {
  if (!sheetsApi) sheetsApi = google.sheets({ version: 'v4', auth: googleAuth() });
  return sheetsApi;
}

function cell(row, index) {
  const value = row[index];
  return value == null ? '' : String(value);
}

// Перетворює рядок таблиці у зрозумілий об'єкт (rowNumber — 1-based у Sheet).
function toItem(row, rowNumber) {
  return {
    rowNumber,
    id: cell(row, COL.id).trim(),
    category: cell(row, COL.category).trim(),
    theme: cell(row, COL.theme).trim(),
    pubDate: cell(row, COL.pubDate).trim(),
    status: cell(row, COL.status).trim().toUpperCase(),
    slides: cell(row, COL.slides).trim(),
    // Колонка G «Додаткові вказівки» — саме сюди лягає промт для ChatGPT.
    // Читаємо, щоб можна було звірити, що він реально отримав.
    extra: cell(row, COL.extra),
    archive: cell(row, COL.archive).trim(),
    sources: cell(row, COL.sources).trim(),
    note: cell(row, COL.note).trim(),
    // Назву й опис НЕ тримуємо: показуємо точно як у таблиці (абзаци, емодзі).
    title: cell(row, COL.title),
    description: cell(row, COL.description),
  };
}

// Усі рядки таблиці як об'єкти (без шапки). Шапку шукаємо за коміркою A='ID',
// щоб не залежати від можливого порожнього першого рядка.
export async function readAllItems() {
  const res = await api().spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
  const rows = res.data.values || [];
  const items = [];
  let headerSeen = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const first = cell(row, COL.id).trim().toUpperCase();
    if (!headerSeen) {
      if (first === 'ID') headerSeen = true; // знайшли шапку — далі дані
      continue;
    }
    if (!row.some((c) => String(c ?? '').trim())) continue; // порожній рядок
    items.push(toItem(row, i + 1));
  }
  return items;
}

// Матеріал вважається ГОТОВИМ до монтажу, якщо статус DONE і заповнені
// обов'язкові поля (ID, Архів, Назва, Опис).
export function isReady(item) {
  return (
    item.status === 'DONE' &&
    item.id &&
    item.archive &&
    item.title.trim() &&
    item.description.trim()
  );
}

// Готові матеріали (DONE, повністю заповнені).
export async function listDoneItems() {
  return (await readAllItems()).filter(isReady);
}

// Опубліковані матеріали (для списку в мінідодатку) — новіші зверху.
export async function listPublishedItems() {
  return (await readAllItems())
    .filter((it) => it.status === 'PUBLISHED')
    .reverse();
}

// Переводить рядок DONE → PUBLISHED: пише дату публікації (кол. D) і статус
// (кол. E). Інші поля не чіпає. Кидає помилку, якщо ID не знайдено або він
// уже не в статусі DONE (захист від повторної обробки).
export async function markPublished(id, when = new Date()) {
  const items = await readAllItems();
  const item = items.find((it) => it.id === id);
  if (!item) throw new Error(`ID ${id} не знайдено в таблиці`);
  if (item.status === 'PUBLISHED') return { rowNumber: item.rowNumber, alreadyPublished: true };
  if (item.status !== 'DONE') {
    throw new Error(`ID ${id} у статусі ${item.status}, а не DONE — не публікую`);
  }
  const date = formatKyivDate(when);
  await api().spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!D${item.rowNumber}:E${item.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[date, 'PUBLISHED']] },
  });
  return { rowNumber: item.rowNumber, date };
}

// Додає рядок у чергу зі статусом NEW і готовим промтом у колонці
// «Додаткові вказівки» (G). ChatGPT за відкладеним завданням бере саме цей
// рядок: малює фото за промтом, пакує архів, заповнює H/M/N і ставить DONE.
export async function appendQueueRow({ id, category = '', theme, slides, prompt, note = '' }) {
  const created = formatKyivDateTime(new Date());
  const row = [
    id, category, theme, '', 'NEW', String(slides ?? ''), prompt,
    '', created, '', '', note, '', '',
  ];
  await api().spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  return { id, created };
}

// Дата-час DD.MM.YYYY HH:MM:SS за київським часом (як у наявних рядках).
function formatKyivDateTime(date) {
  const p = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('day')}.${g('month')}.${g('year')} ${g('hour')}:${g('minute')}:${g('second')}`;
}

// Дата у форматі DD.MM.YYYY за київським часом (як у наявних рядках).
function formatKyivDate(date) {
  const parts = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}`;
}

export { SHEET_ID, TAB };
