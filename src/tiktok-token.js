// Токени TikTok на Google Drive.
//
// Чому файл, а не змінна оточення: TikTok ротує refresh-токен — при кожному
// оновленні видає НОВИЙ і одразу анулює старий. Значення у Railway Variables
// застосунок переписати не може, тож після першого ж оновлення воно стає
// мертвим, і перший-ліпший перезапуск ламає автопостинг. Тому робочий токен
// живе файлом поруч із notices.json, а змінна TIKTOK_REFRESH_TOKEN лишається
// лише СТАРТОВИМ ЗЕРНОМ на випадок, коли авторизацію робили деінде.
import { drive } from './drive.js';
import { promptFolderId } from './kyiv.js';

const FILE_NAME = 'tiktok-token.json';

async function findFile() {
  const res = await drive().files.list({
    q: `'${promptFolderId()}' in parents and name = '${FILE_NAME}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

// { refreshToken, accessToken, accessExpiresAt (ISO), scope, openId, updatedAt }
export async function readTokens() {
  const id = await findFile();
  if (!id) return null;
  try {
    const res = await drive().files.get({ fileId: id, alt: 'media', supportsAllDrives: true });
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return data && data.refreshToken ? data : null;
  } catch {
    return null; // побитий файл — відкотимось на зерно зі змінної
  }
}

export async function writeTokens(tokens) {
  const doc = { ...tokens, updatedAt: new Date().toISOString() };
  const media = { mimeType: 'application/json', body: JSON.stringify(doc, null, 2) };
  const existing = await findFile();
  if (existing) await drive().files.update({ fileId: existing, media, supportsAllDrives: true });
  else {
    await drive().files.create({
      requestBody: { name: FILE_NAME, parents: [promptFolderId()] },
      media, fields: 'id', supportsAllDrives: true,
    });
  }
  return doc;
}

// Стан для діагностики — БЕЗ самих токенів.
export async function tokenStatus() {
  const t = await readTokens();
  if (!t) {
    return {
      stored: false,
      seedFromEnv: Boolean(process.env.TIKTOK_REFRESH_TOKEN),
    };
  }
  return {
    stored: true,
    scope: t.scope || null,
    openId: t.openId ? `${String(t.openId).slice(0, 6)}…` : null,
    accessExpiresAt: t.accessExpiresAt || null,
    updatedAt: t.updatedAt || null,
  };
}
