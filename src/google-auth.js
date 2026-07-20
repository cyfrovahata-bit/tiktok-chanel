// Спільна авторизація Google для додатка на Railway (Sheets + Drive).
// Використовує СЕРВІС-АКАУНТ: увесь JSON-ключ лежить у змінній середовища
// GOOGLE_SERVICE_ACCOUNT_JSON (у Railway Variables — не в коді й не в чаті).
// Таблицю треба розшарити цьому service-account email на «Редактор»,
// а папку Drive з архівами — на «Перегляд».
import { google } from 'googleapis';

let cached = null;

// Області доступу: запис у таблицю (статус PUBLISHED) + Drive (читати ZIP-архіви
// і вивантажувати готові відео у папку «video»). Повний drive-scope, бо
// сервіс-акаунт усе одно бачить лише те, що йому явно розшарено.
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

function credentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      'Не задано GOOGLE_SERVICE_ACCOUNT_JSON — додай увесь JSON сервіс-акаунта у змінні Railway.',
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON — некоректний JSON: ${error.message}`);
  }
}

// Єдиний екземпляр GoogleAuth на процес (кешується).
export function googleAuth() {
  if (!cached) {
    cached = new google.auth.GoogleAuth({ credentials: credentials(), scopes: SCOPES });
  }
  return cached;
}

// Email сервіс-акаунта (для підказки користувачу, кому шарити доступ).
export function serviceAccountEmail() {
  try {
    return credentials().client_email ?? null;
  } catch {
    return null;
  }
}

// Чи налаштовано Google-доступ (щоб не запускати монітор без ключа).
export function googleConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}
