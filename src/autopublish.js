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
import { shortDisplacedByLong, isCompilationDay, COMPILATION_HOUR, LONG_VIDEO_PLATFORMS } from './long-plan.js';
import { sendMessage, ownerChatId } from './telegram.js';

const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tiktok-chanel-production.up.railway.app').replace(/\/$/, '');
const CHECK_MS = Number(process.env.AUTO_PUBLISH_CHECK_MS) || 60 * 1000;
const RETRY_MS = Number(process.env.AUTO_PUBLISH_RETRY_MS) || 5 * 60 * 1000;

// Години публікації (київські), через кому. Кожен слот живе дві години —
// година запуску й наступна, щоб затримка монтажу не з'їдала пост.
//
// У кожної платформи свій найкращий час, тож розклад задається окремо:
// AUTO_PUBLISH_HOURS_YOUTUBE, _TIKTOK, _INSTAGRAM, _FACEBOOK. Якщо для
// платформи змінної немає, береться спільна AUTO_PUBLISH_HOURS — так
// поведінка каналів, які нічого не міняли, лишається тією самою.
const DEFAULT_HOURS = '10,18';

function parseHours(raw) {
  return String(raw)
    .split(',').map((h) => Number(String(h).trim().slice(0, 2)))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b);
}

export function platformHours(platform) {
  const own = process.env[`AUTO_PUBLISH_HOURS_${String(platform).toUpperCase()}`];
  const hours = parseHours(own || process.env.AUTO_PUBLISH_HOURS || DEFAULT_HOURS);
  return hours.length ? hours : parseHours(DEFAULT_HOURS);
}

// Години публікації назовні — мінідодаток рахує з них зворотний відлік.
// Об'єднання розкладів усіх увімкнених платформ: відлік показує найближчу
// подію, хай навіть вона стосується лише однієї з них.
export function publishHours() {
  const platforms = enabledMetaPlatforms();
  if (!platforms.length) return parseHours(process.env.AUTO_PUBLISH_HOURS || DEFAULT_HOURS);
  const all = new Set();
  for (const platform of platforms) for (const hour of platformHours(platform)) all.add(hour);
  return [...all].sort((a, b) => a - b);
}

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
function slotFor(hours, now = new Date()) {
  const { date, hour } = kyivParts(now);
  const slot = hours.find((h) => hour === h || hour === h + 1);
  if (slot === undefined) return null;
  const label = `${String(slot).padStart(2, '0')}:00`;
  return { key: `${date}-${label.slice(0, 2)}`, label };
}

// Спільне вікно (об'єднання всіх платформ) — для мінідодатка й діагностики.
export function currentPublishSlot(now = new Date()) {
  return slotFor(publishHours(), now);
}

function enabledMetaPlatforms() {
  const platforms = [];
  // Facebook свідомо вимкнено, і саме тут, а не змінною оточення — щоб не
  // залежати від того, що стоїть в ENABLE_FB.
  //
  // Причина: Reels, опубліковані через Graph API, на цій сторінці не
  // отримують розповсюдження — 17 і 29 переглядів проти 69 і 644 у тих самих
  // роликів, опублікованих із застосунку. Перевірено й відкинуто: формат
  // файлу (відповідає специфікації Meta до останнього параметра), спосіб
  // доставки (посилання проти байтів), ШІ-позначка, публікація через
  // чернетки, статус перевірки додатка (Instagram публікується тим самим
  // додатком і показується нормально). Усі поля Graph у ручного й
  // API-допису однакові. Причину встановити не вдалося.
  //
  // Facebook публікується вручну з мінідодатка. Щоб повернути автопублікацію,
  // досить розкоментувати рядок нижче.
  // if (process.env.ENABLE_FB === '1') platforms.push('facebook');
  if (process.env.ENABLE_IG === '1') platforms.push('instagram');
  if (process.env.ENABLE_TIKTOK === '1') platforms.push('tiktok');
  if (process.env.ENABLE_YOUTUBE === '1') platforms.push('youtube');
  return platforms;
}

const PLATFORM_META = {
  facebook: { idProperty: 'facebookPostId', label: 'Facebook' },
  instagram: { idProperty: 'instagramPostId', label: 'Instagram' },
  tiktok: { idProperty: 'tiktokPostId', label: 'TikTok' },
  youtube: { idProperty: 'youtubePostId', label: 'YouTube' },
};

function platformIdProperty(platform) {
  return PLATFORM_META[platform]?.idProperty ?? `${platform}PostId`;
}

// Мітка «цій платформі цей ролик не піде ніколи». Ставиться вечірнім роликам
// у дні довгих збірок: YouTube і Facebook отримують того дня саму збірку, а
// сюжет із неї окремо там не виходить — інакше глядач побачив би його двічі.
// Без такої мітки черга просто віддала б ролик YouTube наступного ранку: вона
// тримає його доти, доки він потрібен хоч комусь із увімкнених платформ.
export function platformSkipProperty(platform) {
  return `${platform}Skipped`;
}

// Платформа своє відпрацювала: або опублікувала, або їй свідомо не піде.
function platformSettled(props, platform) {
  return Boolean(props?.[platformIdProperty(platform)] || props?.[platformSkipProperty(platform)]);
}

// Мітка «цей ролик узято в роботу для цієї платформи в цьому вікні». Раніше
// мітка була одна на всі платформи (autoPostSlot), але з роздільним розкладом
// YouTube може публікуватися ввечері, а TikTok опівдні — і спільна мітка
// назавжди закривала б ролик для тих, чиє вікно ще не настало.
export function claimProperty(platform) {
  return `autoSlot${String(platform).charAt(0).toUpperCase()}${String(platform).slice(1)}`;
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

function findClaimedFile(files, slotKey, platform) {
  const key = claimProperty(platform);
  return [...files.values()].find((file) => file.appProperties?.[key] === slotKey) || null;
}

function findItemForFile(items, file) {
  const storedId = file.appProperties?.autoPostItemId;
  return items.find((item) => item.id === storedId)
    || items.find((item) => videoName(item.id) === file.name)
    || null;
}

// Нагадування про Facebook. Автопублікації там немає свідомо (див. коментар
// в enabledMetaPlatforms), тож у своє вікно ми не постимо, а пишемо власникові:
// ось готовий ролик, опублікуй руками. Рівно один раз на ролик — нагадування,
// а не докучання. Вмикається змінною ENABLE_FB_REMINDER=1.
export async function remindFacebookOnce({
  now = new Date(),
  listItems = readAllItems,
  listFiles = listVideoFiles,
  setProperties = setVideoAppProperties,
  notifyFn = sendMessage,
  publicUrl = PUBLIC_URL,
} = {}) {
  if (process.env.ENABLE_FB_REMINDER !== '1') return null;
  const slot = slotFor(platformHours('facebook'), now);
  if (!slot) return null;

  const [items, files] = await Promise.all([listItems(), listFiles()]);

  // Одне нагадування на вікно. Без цієї перевірки після позначки першого
  // ролика наступний тик (через хвилину) узяв би другий, потім третій — і
  // замість нагадування вийшов би обстріл усією чергою за три хвилини.
  const alreadyThisSlot = [...files.values()]
    .some((file) => file.appProperties?.facebookRemindedSlot === slot.key);
  if (alreadyThisSlot) return null;

  const candidate = items
    .filter(isReady)
    .filter((item) => item.status !== 'PUBLISHED')
    .map((item) => ({ item, file: files.get(videoName(item.id)) }))
    .find(({ file }) => (
      file
      && !file.appProperties?.facebookPostId
      && !file.appProperties?.facebookSkipped // вечір дня збірки — Facebook його не отримує
      && !file.appProperties?.facebookRemindedAt
    ));
  if (!candidate) return null;

  const { item, file } = candidate;
  await notify(
    `📘 Facebook чекає на тебе:\n${item.title}\n\n`
    + `Відео: ${String(publicUrl).replace(/\/$/, '')}/api/video/${encodeURIComponent(item.id)}\n`
    + 'Назву й опис бери в мінідодатку — там кнопка «копіювати».\n\n'
    + 'Нагадую про цей ролик один раз.',
    notifyFn,
  );
  const patch = { facebookRemindedAt: now.toISOString(), facebookRemindedSlot: slot.key };
  await setProperties(file.id, patch);
  applyLocalProperties(file, patch);
  return { itemId: item.id, slot: slot.key };
}

// Один безпечний прохід. Залежності ін'єктуються для тестів; у Railway
// використовуються Google Sheet, Drive, Meta API та Telegram.
export async function runAutoPublishOnce(options = {}) {
  const {
    now = new Date(),
    listItems = readAllItems,
    listFiles = listVideoFiles,
  } = options;

  const reminder = await remindFacebookOnce(options).catch((error) => {
    console.error('[autopublish] нагадування про Facebook:', error.message);
    return null;
  });

  // Платформи з роздільним розкладом групуються за вікном: ті, у кого воно
  // зараз спільне, обробляються разом і дістають один ролик на всіх — як було
  // до появи окремих годин. У кого вікно своє — той іде власною чергою.
  const groups = new Map();
  for (const platform of enabledMetaPlatforms()) {
    const slot = slotFor(platformHours(platform), now);
    if (!slot) continue;
    // У неділю, вівторок і п'ятницю вечірній слот YouTube займає довга
    // збірка — шортс туди не йде, щоб два своїх відео не змагалися між собою
    // за той самий показ.
    if (shortDisplacedByLong(platform, slot.label.slice(0, 2), now)) continue;
    if (!groups.has(slot.key)) groups.set(slot.key, { slot, platforms: [] });
    groups.get(slot.key).platforms.push(platform);
  }
  if (!groups.size) {
    return reminder
      ? { status: 'facebook-reminded', itemId: reminder.itemId }
      : { status: 'outside-window' };
  }

  const [items, files] = await Promise.all([listItems(), listFiles()]);
  const results = [];
  for (const group of groups.values()) {
    results.push(await runGroup({ ...options, items, files, ...group }));
  }
  if (results.length === 1) {
    return reminder ? { ...results[0], facebookReminded: reminder.itemId } : results[0];
  }
  return { status: 'multi', results, facebookReminded: reminder?.itemId };
}

async function runGroup({
  now = new Date(),
  slot,
  platforms,
  items,
  files,
  setProperties = setVideoAppProperties,
  publishPlatform = publish,
  notifyFn = sendMessage,
  publicUrl = PUBLIC_URL,
}) {
  // Службові мітки теж на групу, а не на файл цілком: інакше дві групи в
  // одному вікні перетирали б одна одній «уже сповістив» і «остання спроба».
  const groupKey = claimProperty(platforms[0]);
  const NOTIFIED = `${groupKey}Notified`;
  const ERR_NOTIFIED = `${groupKey}ErrNotified`;
  const ATTEMPT_AT = `${groupKey}At`;

  let file = findClaimedFile(files, slot.key, platforms[0]);
  let item = file ? findItemForFile(items, file) : null;

  if (!file) {
    // Беремо НАЙСТАРІШЕ готове й ще не опубліковане. Порядок — як у таблиці
    // (нові рядки дописуються в кінець), тож черга виходить сама собою.
    // Враховуємо також marker-файли, які лишаються після перегенерації.
    // Marker-файли лишаються після перегенерації і пам'ятають, що цей ролик
    // уже кудись виходив. Беремо саме їх, а не всі файли: мітка на самому
    // відео тепер означає лише «взято в роботу однією з платформ», і чужа
    // платформа не повинна через неї втрачати свою чергу.
    const claimedItemIds = new Set(
      [...files.values()]
        .filter((candidateFile) => String(candidateFile.name || '').endsWith('.autopost.json'))
        .map((candidateFile) => candidateFile.appProperties?.autoPostItemId)
        .filter(Boolean),
    );
    // Черга ОДНА на всі платформи, хоч години в кожної свої. Беремо
    // найстаріший ролик, якого бракує хоч комусь із увімкнених, — і саме його
    // ця група публікує у своє вікно.
    //
    // Раніше кожна платформа шукала «найстаріше, чого немає в НЕЇ», і черги
    // розповзалися: ролик, змонтований о 17:00, TikTok забирав о 18:00 того ж
    // дня, а Instagram аж наступного об 11:00 — і відставав на крок назавжди,
    // бо теж робив три на добу. Виходило по різному відео на кожній платформі.
    const wanted = enabledMetaPlatforms();
    const candidates = items
      .filter(isReady) // DONE + архів + назва + опис
      .filter((candidate) => candidate.status !== 'PUBLISHED') // вже вийшло вручну
      .map((candidate) => ({ item: candidate, file: files.get(videoName(candidate.id)) }))
      .filter(({ item: candidate, file: candidateFile }) => (
        candidateFile // відео змонтоване
        // Комусь із увімкнених платформ цього ролика ще бракує — отже черга
        // на ньому й стоїть, поки всі не отримають своє. Стару мітку клейма
        // тут НЕ перевіряємо: група могла взяти ролик учора, опублікувати
        // своє й далі чекати решту — і завтра має лишитися на ньому ж.
        && wanted.some((platform) => !platformSettled(candidateFile.appProperties, platform))
        // Скинуте вручну в цьому ж вікні: інакше воно вийшло б повторно
        // тим самим тиком, і скидання не мало б сенсу.
        && candidateFile.appProperties?.autoPostSkipSlot !== slot.key
        && !claimedItemIds.has(candidate.id)
      ));
    const candidate = candidates[0]; // найстаріший рядок згори
    if (!candidate) return { status: 'waiting-for-video', slot: slot.key };
    ({ file, item } = candidate);
    // Цій групі на спільному ролику вже нічого робити — вона своє віддала й
    // чекає, поки дотягнуться платформи з пізнішими вікнами. Клейм не ставимо
    // й повідомлень не шлемо, інакше кожне вікно давало б «уже опубліковано».
    if (!platforms.some((platform) => !platformSettled(file.appProperties, platform))) {
      return { status: 'in-step', slot: slot.key, itemId: item.id };
    }
    // autoPostSlot/autoPostItemId лишаються як спільна мітка: на них
    // спираються мінідодаток і збереження історії при перегенерації.
    const claim = { autoPostSlot: slot.key, autoPostItemId: item.id };
    for (const platform of platforms) claim[claimProperty(platform)] = slot.key;
    // Вечір дня збірки: цей сюжет виходить лише в TikTok та Instagram, а на
    // YouTube і Facebook він не з'явиться ніколи — там сьогодні сама збірка.
    // Мітку ставимо ОДРАЗУ, разом із клеймом: інакше завтрашня черга віддала б
    // ролик YouTube як «ще не опублікований».
    if (isCompilationDay(now) && Number(slot.label.slice(0, 2)) === COMPILATION_HOUR) {
      for (const platform of LONG_VIDEO_PLATFORMS) claim[platformSkipProperty(platform)] = slot.key;
    }
    await setProperties(file.id, claim);
    applyLocalProperties(file, claim);
  }

  if (!item) {
    return { status: 'missing-sheet-row', slot: slot.key, fileId: file.id };
  }

  const missing = platforms.filter((platform) => !platformSettled(file.appProperties, platform));
  if (!missing.length) {
    if (file.appProperties?.[NOTIFIED] !== slot.key) {
      await notify(
        `✅ Автопублікація завершена:\n${item.title}\n\n${platforms.map(platformLabel).join(' та ')} — опубліковано.\nТаблицю не змінював.`,
        notifyFn,
      );
      const patch = { autoPostDone: '1', [NOTIFIED]: slot.key };
      await setProperties(file.id, patch);
      applyLocalProperties(file, patch);
    }
    return { status: 'published', slot: slot.key, itemId: item.id };
  }

  const lastAttempt = Date.parse(file.appProperties?.[ATTEMPT_AT] || '');
  if (Number.isFinite(lastAttempt) && now.getTime() - lastAttempt < RETRY_MS) {
    return { status: 'cooldown', slot: slot.key, itemId: item.id };
  }
  const attemptPatch = { [ATTEMPT_AT]: now.toISOString() };
  await setProperties(file.id, attemptPatch);
  applyLocalProperties(file, attemptPatch);

  // Байти потрібні і TikTok, і Facebook. Тягнемо з Drive ліниво й один раз на
  // рядок: платформ до трьох, а ролик важить кілька мегабайтів.
  let bufferOnce = null;
  const payload = {
    videoUrl: `${String(publicUrl).replace(/\/$/, '')}/api/video/${encodeURIComponent(item.id)}`,
    title: item.title,
    description: item.description,
    videoBuffer: () => {
      if (!bufferOnce) bufferOnce = fetchVideoBuffer(file.id);
      return bufferOnce;
    },
    // Мітку обкладинки поклав монтаж (pipeline.js) на сам файл у Drive.
    coverMs: Number(file.appProperties?.coverMs) || null,
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
    if (file.appProperties?.[ERR_NOTIFIED] !== slot.key) {
      const ok = platforms.filter((platform) => !stillMissing.includes(platform)).map(platformLabel);
      const failed = errors.map((result) => `${platformLabel(result.platform)}: ${result.detail}`).join('\n');
      await notify(
        `⚠️ Автопублікація не завершена:\n${item.title}\n\n${ok.length ? `Успішно: ${ok.join(', ')}\n` : ''}${failed}\n\nПовторю спробу автоматично. Таблицю не змінював.`,
        notifyFn,
      );
      const patch = { [ERR_NOTIFIED]: slot.key };
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
    const patch = { autoPostDone: '1', [NOTIFIED]: slot.key };
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

  const schedule = enabledMetaPlatforms()
    .map((platform) => `${platformLabel(platform)} ${platformHours(platform).map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')}`)
    .join(' · ') || 'платформи вимкнені';
  const fb = process.env.ENABLE_FB_REMINDER === '1'
    ? ` · нагадування Facebook ${platformHours('facebook').map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')}`
    : '';
  console.log(`[autopublish] розклад Europe/Kyiv — ${schedule}${fb}`);
  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
