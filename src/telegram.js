// Обгортка Telegram Bot API. Без фреймворків — прямі виклики через fetch,
// бо процес живе лічені секунди всередині GitHub Actions.
import { readFile, writeFile } from 'node:fs/promises';

const API_ROOT = 'https://api.telegram.org';

function token() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error('Не задано змінну середовища TELEGRAM_BOT_TOKEN');
  return value;
}

export function ownerChatId() {
  const value = process.env.TELEGRAM_CHAT_ID;
  if (!value) throw new Error('Не задано змінну середовища TELEGRAM_CHAT_ID');
  return String(value);
}

async function call(method, payload = {}) {
  const response = await fetch(`${API_ROOT}/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${data.description ?? `HTTP ${response.status}`}`);
  }
  return data.result;
}

// timeout=0 — миттєва відповідь (потрібно старому скрипту check.js, який живе
// лічені секунди). Довгоживучому серверу вигідніше довге опитування: Telegram
// тримає з'єднання й віддає оновлення щойно вони з'являються.
export function getUpdates(offset, timeout = 0) {
  return call('getUpdates', {
    offset,
    timeout,
    allowed_updates: ['message', 'callback_query'],
  });
}

// Telegram відхиляє повідомлення, довші за 4096 символів («message is too
// long»). Ділимо довгий текст по межах рядків, щоб довгий промпт ніколи не
// валив запуск (кнопку чіпляємо лише до останньої частини).
const TELEGRAM_TEXT_LIMIT = 4096;

function splitForTelegram(text, limit = TELEGRAM_TEXT_LIMIT) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    // Один наддовгий рядок (рідкість) — ріжемо жорстко по ліміту.
    if (line.length > limit) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if ((current ? current.length + 1 : 0) + line.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Без parse_mode: промпт має копіюватись у ChatGPT як є, а тексти публікації
// не повинні містити жодного зайвого символу розмітки.
export async function sendMessage(chatId, text, replyMarkup) {
  const chunks = splitForTelegram(String(text));
  let result;
  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, text: chunks[i] };
    // reply_markup (кнопку) — лише на останній частині, щоб опинилась унизу.
    if (replyMarkup && i === chunks.length - 1) payload.reply_markup = replyMarkup;
    result = await call('sendMessage', payload);
  }
  return result;
}

export function answerCallbackQuery(callbackQueryId, text) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  return call('answerCallbackQuery', payload);
}

export function editMessageReplyMarkup(chatId, messageId, replyMarkup = { inline_keyboard: [] }) {
  return call('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

// Повертає file_path на серверах Telegram (для downloadFile).
export async function getFile(fileId) {
  const result = await call('getFile', { file_id: fileId });
  if (!result.file_path) throw new Error(`Telegram getFile: нема file_path для ${fileId}`);
  return result.file_path;
}

export async function downloadFile(filePath, destination) {
  const response = await fetch(`${API_ROOT}/file/bot${token()}/${filePath}`);
  if (!response.ok) {
    throw new Error(`Telegram download ${filePath}: HTTP ${response.status}`);
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

export async function sendVideo(chatId, videoPath) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('width', '1080');
  form.append('height', '1920');
  form.append('supports_streaming', 'true');
  form.append('video', new Blob([await readFile(videoPath)], { type: 'video/mp4' }), 'out.mp4');
  const response = await fetch(`${API_ROOT}/bot${token()}/sendVideo`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram sendVideo: ${data.description ?? `HTTP ${response.status}`}`);
  }
  return data.result;
}
