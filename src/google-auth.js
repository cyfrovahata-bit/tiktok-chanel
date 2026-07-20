// Спільна авторизація Google для додатка на Railway (Sheets + Drive).
// Використовує СЕРВІС-АКАУНТ: увесь JSON-ключ лежить у змінній середовища
// GOOGLE_SERVICE_ACCOUNT_JSON (у Railway Variables — не в коді й не в чаті).
// Приймається як сирий JSON, ТАК І base64 (щоб уникнути проблем із
// перенесеннями рядків при вставці у Railway). Таблицю треба розшарити цьому
// service-account email на «Редактор», а папки Drive — теж на «Редактор».
import { google } from 'googleapis';

let cached = null;

// Області доступу: запис у таблицю (статус PUBLISHED) + Drive (читати ZIP-архіви
// і вивантажувати готові відео у папку «video»). Повний drive-scope, бо
// сервіс-акаунт усе одно бачить лише те, що йому явно розшарено.
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

// Повертає розпарсений ключ. Кидає зрозумілу помилку, якщо змінна порожня,
// або JSON пошкоджений/обрізаний (типова причина — багаторядкова вставка).
function credentials() {
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) {
    throw new Error('Не задано GOOGLE_SERVICE_ACCOUNT_JSON — додай ключ сервіс-акаунта у змінні Railway.');
  }
  raw = raw.trim();
  // Іноді значення прилітає в лапках (наприклад, скопійоване разом із ними) —
  // акуратно знімаємо зовнішні лапки.
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  // Якщо це не схоже на JSON (не починається з «{») — пробуємо base64
  // (прибравши будь-які пробіли/переноси, якщо кодування рядок розбило).
  if (!raw.startsWith('{')) {
    try {
      const decoded = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) raw = decoded;
    } catch { /* лишаємо як є — впаде на JSON.parse нижче */ }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON не парситься (${error.message}). Схоже, ключ обрізано при вставці — встав його у base64 або перевір, що скопійовано ВЕСЬ файл.`,
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('У ключі немає client_email/private_key — це не повний JSON сервіс-акаунта.');
  }
  return parsed;
}

// Єдиний екземпляр GoogleAuth на процес (кешується).
export function googleAuth() {
  if (!cached) {
    cached = new google.auth.GoogleAuth({ credentials: credentials(), scopes: SCOPES });
  }
  return cached;
}

// Діагностика для /healthz: чи задано змінну, який email, і причина, якщо ключ
// не читається. Без секретів — лише email (він і так публічний) і текст помилки.
export function serviceAccountStatus() {
  const configured = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (!configured) return { configured: false, email: null, error: 'not set' };
  try {
    return { configured: true, email: credentials().client_email, error: null };
  } catch (error) {
    return { configured: true, email: null, error: error.message };
  }
}

export function serviceAccountEmail() {
  return serviceAccountStatus().email;
}

// Чи можна запускати монітор (ключ заданий і коректний).
export function googleConfigured() {
  return serviceAccountStatus().email != null;
}
