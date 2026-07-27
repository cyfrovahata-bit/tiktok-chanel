// Автопублікація готових відео о 10:00 та 18:00 за Europe/Kyiv.
//
// Черга, а не розклад: щослота беремо НАЙСТАРІШЕ готове відео, яке ще не
// публікували. Так можна клепати ролики наперед — вони самі виходитимуть по
// два на добу, доки запас не скінчиться. Раніше слот був жорстко прив'язаний
// до часу генерації (о 10:00 — вчорашній вечір, о 18:00 — сьогоднішній
// ранок), і зроблений заздалегідь матеріал просто ніколи не діждався б черги.
//
// Таблицю не змінює: слот, ID постів і захист від дублів зберігаються в
// appProperties самого MP4 на Google Drive. Рядок лишається в черзі
// мінідодатку, щоб можна було забрати відео для TikTok і позначити
// «Опубліковано» руками, коли справді все зроблено.
import { readAllItems, isReady } from './sheets.js';
import { listVideoFiles, setVideoAppProperties, videoName, streamVideo } from './videos.js';
import { publish } from './publish.js';
import { sendMessage, ownerChatId } from './telegram.js';

const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tiktok-chanel-production.up.railway.app').replace(/\/$/, '');
const CHECK_MS = Number(process.env.AUTO_PUBLISH_CHECK_MS) || 60 * 1000;
// Години публікації (київські), через кому. Кожен слот живе дві години —
// година запуску й наступна, щоб затримка монтажу не з'їдала пост.
const PUBLISH_HOURS = String(process.env.AUTO_PUBLISH_HOURS || '10,18')
  .split(',').map((h) => Number(String(h).trim().slice(0, 2)))
  .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
  .sort((a, b) => a - b);
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

// Даємо дві години на випадок, якщо монтаж трохи затримався. У межах вікна
// слот той самий, тож повторного поста не буде. Ключ слота містить годину,
// а не «am/pm», інакше три слоти на добу злилися б у два.
export function currentPublishSlot(now = new Date()) {
  const { date, hour } = kyivParts(now);
  const slot = PUBLISH_HOURS.find((h) => hour === h || hour === h + 1);
  if (slot === undefined) return null;
  const label = `${String(slot).padStart(2, '0')}:00`;
  return { key: `${date}-${label.slice(0, 2)}`, label };
}

function enabledMetaPlatforms() {
  const platforms = [];
  if (process.env.ENABLE_FB === '1') platforms.push('facebook');
  if (process.env.ENABLE_IG === '1') platforms.push('instagram');
  if (process.env.ENABLE_TIKTOK === '1') platforms.push('tiktok');
  return platforms;
}

const PLATFORM_META = {
  facebook: { idProperty: 'facebookPostId', label: 'Facebook' },
  instagram: { idProperty: 'instagramPostId', label: 'Instagram' },
  tiktok: { idProperty: 'tiktokPostId', label: 'TikTok' },
};

function platformIdProperty(platform) {
  return PLATFORM_META[platform]?.idProperty ?? `${platform}PostId`;
}

function platformLabel(platform) {
  return PLATFORM_META[platform]?.label ?? platform;
}

async function notify(text, notifyFn = sendMessage) {
  try { await notifyFn(ownerChatId(), text); }
  catch (error) { console.error('[autopublish] Telegram:', error.message); }
}

// Завантажує готовий MP4 із Drive у пам'ять (ролики ~5 МБ).
async function fetchVideoBuffer(fileId) {
  const { stream } = await streamVideo(fileId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
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
    // Беремо НАЙСТАРІШЕ готове й ще не опубліковане. Порядок — як у таблиці
    // (нові рядки дописуються в кінець), тож черга виходить сама собою.
    // Враховуємо також marker-файли, які лишаються після перегенерації.
    const claimedItemIds = new Set(
      [...files.values()]
        .map((candidateFile) => candidateFile.appProperties?.autoPostItemId)
        .filter(Boolean),
    );
    const candidates = items
      .filter(isReady) // DONE + архів + назва + опис
      .filter((candidate) => candidate.status !== 'PUBLISHED') // вже вийшло вручну
      .map((candidate) => ({ item: candidate, file: files.get(videoName(candidate.id)) }))
      .filter(({ item: candidate, file: candidateFile }) => (
        candidateFile // відео змонтоване
        && !candidateFile.appProperties?.autoPostSlot // ще не бралося в роботу
        // Скинуте вручну в цьому ж вікні: інакше воно вийшло б повторно
        // тим самим тиком, і скидання не мало б сенсу.
        && candidateFile.appProperties?.autoPostSkipSlot !== slot.key
        && !claimedItemIds.has(candidate.id)
      ));
    const candidate = candidates[0]; // найстаріший рядок згори
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
    // TikTok вантажить байти, а не посилання. Ліниво: Meta цього не торкається,
    // тож зайвого завантаження з Drive не буде, якщо TikTok вимкнено.
    videoBuffer: () => fetchVideoBuffer(file.id),
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
