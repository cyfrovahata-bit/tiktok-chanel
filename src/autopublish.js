// Автопублікація готових відео о 10:00 та 18:00 за Europe/Kyiv.
// О 10:00 виходить матеріал із попереднього вечора, о 18:00 — із поточного
// ранку. Так між генерацією та публікацією лишається час на ручні правки.
// Таблицю не змінює: слот, ID постів і захист від дублів зберігаються в
// appProperties самого MP4 на Google Drive.
import { readAllItems, isReady } from './sheets.js';
import { listVideoFiles, setVideoAppProperties, videoName } from './videos.js';
import { publish } from './publish.js';
import { sendMessage, ownerChatId } from './telegram.js';

const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tiktok-chanel-production.up.railway.app').replace(/\/$/, '');
const CHECK_MS = Number(process.env.AUTO_PUBLISH_CHECK_MS) || 60 * 1000;
const RETRY_MS = Number(process.env.AUTO_PUBLISH_RETRY_MS) || 5 * 60 * 1000;

function kyivParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function shiftIsoDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// Автоматизація створює ID на кшталт AUTO-20260722-0930. Саме ID, а не
// позиція рядка в таблиці, однозначно визначає, коли матеріал згенеровано.
export function generationSlotForItem(item) {
  const match = String(item?.id || '').match(
    /^AUTO-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(?:$|[-_])/i,
  );
  if (!match) return null;

  const [, year, month, day, hourText, minuteText] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour > 23 || minute > 59) return null;

  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return `${date}-${hour < 12 ? 'am' : 'pm'}`;
}

// Даємо дві години на випадок, якщо генерація або монтаж трохи затримались.
// У межах вікна слот той самий, тож повторного поста не буде.
export function currentPublishSlot(now = new Date()) {
  const { date, hour } = kyivParts(now);
  if (hour === 10 || hour === 11) {
    return {
      key: `${date}-am`,
      label: '10:00',
      generationSlot: `${shiftIsoDate(date, -1)}-pm`,
    };
  }
  if (hour === 18 || hour === 19) {
    return {
      key: `${date}-pm`,
      label: '18:00',
      generationSlot: `${date}-am`,
    };
  }
  return null;
}

function enabledMetaPlatforms() {
  const platforms = [];
  if (process.env.ENABLE_FB === '1') platforms.push('facebook');
  if (process.env.ENABLE_IG === '1') platforms.push('instagram');
  return platforms;
}

function platformIdProperty(platform) {
  return platform === 'facebook' ? 'facebookPostId' : 'instagramPostId';
}

function platformLabel(platform) {
  return platform === 'facebook' ? 'Facebook' : 'Instagram';
}

async function notify(text, notifyFn = sendMessage) {
  try { await notifyFn(ownerChatId(), text); }
  catch (error) { console.error('[autopublish] Telegram:', error.message); }
}

function applyLocalProperties(file, patch) {
  file.appProperties = { ...(file.appProperties || {}), ...patch };
}

function findClaimedFile(files, slotKey) {
  return [...files.values()].find((file) => file.appProperties?.autoPostSlot === slotKey) || null;
}

function findItemForFile(items, file) {
  const storedId = file.appProperties?.autoPostItemId;
  return items.find((item) => item.id === storedId)
    || items.find((item) => videoName(item.id) === file.name)
    || null;
}

// Один безпечний прохід. Залежності ін'єктуються для тестів; у Railway
// використовуються Google Sheet, Drive, Meta API та Telegram.
export async function runAutoPublishOnce({
  now = new Date(),
  listItems = readAllItems,
  listFiles = listVideoFiles,
  setProperties = setVideoAppProperties,
  publishPlatform = publish,
  notifyFn = sendMessage,
  publicUrl = PUBLIC_URL,
} = {}) {
  const slot = currentPublishSlot(now);
  if (!slot) return { status: 'outside-window' };

  const platforms = enabledMetaPlatforms();
  if (!platforms.length) return { status: 'disabled', slot: slot.key };

  const [items, files] = await Promise.all([listItems(), listFiles()]);
  let file = findClaimedFile(files, slot.key);
  let item = file ? findItemForFile(items, file) : null;

  if (!file) {
    // Беремо лише матеріал із потрібного генераційного слота: о 10:00 — з
    // попереднього вечора, о 18:00 — з поточного ранку. Якщо його немає,
    // чекаємо й не підміняємо свіжішим постом. Враховуємо також marker-файли,
    // які лишаються після перегенерації.
    const claimedItemIds = new Set(
      [...files.values()]
        .map((candidateFile) => candidateFile.appProperties?.autoPostItemId)
        .filter(Boolean),
    );
    const candidates = items
      .filter(isReady)
      .filter((candidate) => generationSlotForItem(candidate) === slot.generationSlot)
      .map((candidate) => ({ item: candidate, file: files.get(videoName(candidate.id)) }))
      .filter(({ item: candidate, file: candidateFile }) => (
        candidateFile
        && !candidateFile.appProperties?.autoPostSlot
        && !claimedItemIds.has(candidate.id)
      ));
    const candidate = candidates.at(-1);
    if (!candidate) return { status: 'waiting-for-video', slot: slot.key };
    ({ file, item } = candidate);
    const claim = { autoPostSlot: slot.key, autoPostItemId: item.id };
    await setProperties(file.id, claim);
    applyLocalProperties(file, claim);
  }

  if (!item) {
    return { status: 'missing-sheet-row', slot: slot.key, fileId: file.id };
  }

  const missing = platforms.filter((platform) => !file.appProperties?.[platformIdProperty(platform)]);
  if (!missing.length) {
    if (file.appProperties?.autoPostNotified !== slot.key) {
      await notify(
        `✅ Автопублікація завершена:\n${item.title}\n\n${platforms.map(platformLabel).join(' та ')} — опубліковано.\nТаблицю не змінював.`,
        notifyFn,
      );
      const patch = { autoPostDone: '1', autoPostNotified: slot.key };
      await setProperties(file.id, patch);
      applyLocalProperties(file, patch);
    }
    return { status: 'published', slot: slot.key, itemId: item.id };
  }

  const lastAttempt = Date.parse(file.appProperties?.autoPostLastAttemptAt || '');
  if (Number.isFinite(lastAttempt) && now.getTime() - lastAttempt < RETRY_MS) {
    return { status: 'cooldown', slot: slot.key, itemId: item.id };
  }
  const attemptPatch = { autoPostLastAttemptAt: now.toISOString() };
  await setProperties(file.id, attemptPatch);
  applyLocalProperties(file, attemptPatch);

  const payload = {
    videoUrl: `${String(publicUrl).replace(/\/$/, '')}/api/video/${encodeURIComponent(item.id)}`,
    title: item.title,
    description: item.description,
  };
  const results = [];
  for (const platform of missing) {
    try {
      const result = await publishPlatform(platform, payload);
      results.push(result);
      if (result.status === 'published' && result.id) {
        const patch = {
          [platformIdProperty(platform)]: result.id,
          [`${platform}PublishedAt`]: new Date().toISOString(),
        };
        // Фіксуємо кожну платформу одразу — якщо друга впаде, перша не
        // опублікується повторно під час наступної спроби.
        await setProperties(file.id, patch);
        applyLocalProperties(file, patch);
      }
    } catch (error) {
      results.push({ platform, status: 'error', detail: error.message });
    }
  }

  const errors = results.filter((result) => result.status === 'error');
  const stillMissing = platforms.filter((platform) => !file.appProperties?.[platformIdProperty(platform)]);
  if (errors.length) {
    if (file.appProperties?.autoPostErrorNotified !== slot.key) {
      const ok = platforms.filter((platform) => !stillMissing.includes(platform)).map(platformLabel);
      const failed = errors.map((result) => `${platformLabel(result.platform)}: ${result.detail}`).join('\n');
      await notify(
        `⚠️ Автопублікація не завершена:\n${item.title}\n\n${ok.length ? `Успішно: ${ok.join(', ')}\n` : ''}${failed}\n\nПовторю спробу автоматично. Таблицю не змінював.`,
        notifyFn,
      );
      const patch = { autoPostErrorNotified: slot.key };
      await setProperties(file.id, patch);
      applyLocalProperties(file, patch);
    }
    return { status: 'partial-error', slot: slot.key, itemId: item.id, results };
  }

  if (!stillMissing.length) {
    await notify(
      `✅ Автопублікація завершена:\n${item.title}\n\n${platforms.map(platformLabel).join(' та ')} — опубліковано.\nТаблицю не змінював.`,
      notifyFn,
    );
    const patch = { autoPostDone: '1', autoPostNotified: slot.key };
    await setProperties(file.id, patch);
    applyLocalProperties(file, patch);
    return { status: 'published', slot: slot.key, itemId: item.id, results };
  }

  return { status: 'incomplete', slot: slot.key, itemId: item.id, results };
}

export function startAutoPublisher() {
  let stopped = false;
  let running = false;
  let timer = null;

  const tick = async () => {
    if (!running) {
      running = true;
      try {
        const result = await runAutoPublishOnce();
        if (!['outside-window', 'disabled', 'waiting-for-video', 'cooldown'].includes(result.status)) {
          console.log(`[autopublish] ${result.status}${result.itemId ? `: ${result.itemId}` : ''}`);
        }
      } catch (error) {
        console.error('[autopublish] цикл упав:', error.message);
      } finally {
        running = false;
      }
    }
    if (!stopped) {
      const delay = Math.max(1_000, CHECK_MS - (Date.now() % CHECK_MS));
      timer = setTimeout(tick, delay);
    }
  };

  console.log('[autopublish] розклад 10:00 та 18:00 Europe/Kyiv');
  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
