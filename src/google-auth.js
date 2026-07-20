// Авторизація Google для додатка. Два режими:
//
//  1) OAuth (ОСНОВНИЙ) — додаток діє від імені ВЛАСНИКА (твій gmail). Файли
//     (відео) належать тобі й рахуються за твоєю квотою 15 ГБ, і нічого нікому
//     не треба шарити. Потрібні змінні: GOOGLE_OAUTH_CLIENT_ID,
//     GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN.
//     Refresh-token видобувається один раз через /oauth/start у браузері.
//
//  2) Service account (ФОЛБЕК) — лише читання (сервіс-акаунт НЕ має квоти,
//     тож завантажувати відео в звичайний Drive не може). Лишено на випадок,
//     якщо OAuth ще не налаштовано.
import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

let cached = null;

// ---- OAuth -----------------------------------------------------------------
export function oauthConfigured() {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function redirectUri() {
  const base = (process.env.PUBLIC_URL || 'https://tiktok-chanel-production.up.railway.app').replace(/\/$/, '');
  return `${base}/oauth/callback`;
}

export function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri(),
  );
}

// Посилання на згоду Google (offline + prompt=consent, щоб точно повернувся
// refresh_token).
export function consentUrl() {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

// Обмінює code (з /oauth/callback) на токени; повертає tokens (із refresh_token).
export async function exchangeCode(code) {
  const { tokens } = await oauthClient().getToken(code);
  return tokens;
}

// ---- Service account (фолбек) ---------------------------------------------
function serviceCreds() {
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) throw new Error('Немає GOOGLE_SERVICE_ACCOUNT_JSON');
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw.startsWith('{')) {
    try {
      const decoded = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) raw = decoded;
    } catch { /* впаде на JSON.parse */ }
  }
  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) throw new Error('Неповний JSON сервіс-акаунта');
  return parsed;
}

// ---- Єдина точка авторизації ----------------------------------------------
export function googleAuth() {
  if (cached) return cached;
  // Пріоритет — OAuth (немає проблеми з квотою, файли належать користувачу).
  if (process.env.GOOGLE_OAUTH_REFRESH_TOKEN && oauthConfigured()) {
    const client = oauthClient();
    client.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
    cached = client;
    return cached;
  }
  // Фолбек — сервіс-акаунт (тільки читання).
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    cached = new google.auth.GoogleAuth({ credentials: serviceCreds(), scopes: SCOPES });
    return cached;
  }
  throw new Error('Google не налаштовано: задай OAuth (client id/secret/refresh token) або service account.');
}

// ---- Статус для /healthz ---------------------------------------------------
export function googleStatus() {
  if (process.env.GOOGLE_OAUTH_REFRESH_TOKEN && oauthConfigured()) {
    return { mode: 'oauth', ready: true, canUpload: true, error: null };
  }
  if (oauthConfigured()) {
    return { mode: 'oauth', ready: false, canUpload: false, error: 'немає GOOGLE_OAUTH_REFRESH_TOKEN — відкрий /oauth/start' };
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const email = serviceCreds().client_email;
      return { mode: 'service', ready: true, canUpload: false, email, error: 'сервіс-акаунт не може вивантажувати відео — налаштуй OAuth' };
    } catch (error) {
      return { mode: 'service', ready: false, canUpload: false, error: error.message };
    }
  }
  return { mode: 'none', ready: false, canUpload: false, error: 'Google не налаштовано' };
}

// Чи можна запускати монітор — потрібні і доступ, і можливість вивантажувати
// відео (сервіс-акаунт цього не вміє, тож у режимі 'service' монітор не
// стартує, щоб не крутити невдалі спроби, поки не налаштовано OAuth).
export function googleConfigured() {
  const s = googleStatus();
  return s.ready && s.canUpload;
}

export function serviceAccountEmail() {
  const s = googleStatus();
  return s.email ?? null;
}
