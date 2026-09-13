// Власні сюжети: коли тему й текст придумує ВЛАСНИК, а не генератор.
//
// Потік: у мінідодатку власник пише сюжет і (за бажанням) докидає кілька
// своїх фото → тут вони лягають в окрему папку Drive → у таблицю йде рядок
// зі статусом NEW і промтом, який пояснює ChatGPT, що робити з цим
// матеріалом. Далі все як завжди: ChatGPT збирає архів, бот монтує.
//
// Матеріал може бути будь-яким набором: лише текст, лише фото, або й те, й
// інше. Промт нижче розписує ChatGPT кожен із цих випадків окремо, бо саме
// тут найлегше отримати «намалював своє й проігнорував мої фото».
import { Readable } from 'node:stream';
import { drive } from './drive.js';
import { appendQueueRow, readAllItems } from './sheets.js';
import { promptFolderId, kyivToday, kyivMinutes } from './kyiv.js';

// Куди складати матеріали власника. За замовчуванням — та сама папка, де
// лежить drafts.json, щоб не заводити ще одну змінну оточення.
function parentFolderId() {
  return process.env.OWN_FOLDER_ID || promptFolderId();
}

export const MAX_PHOTOS = 12;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

// ID рядка для власного сюжету: OWN-YYYYMMDD-HHMM (щоб не плутати з AUTO-).
export function ownRowId(now = new Date()) {
  const ymd = kyivToday(now).replace(/-/g, '');
  const m = kyivMinutes(now);
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
  return `OWN-${ymd}-${hhmm}`;
}

// Створює папку під один сюжет. Окрема папка на кожен — щоб ChatGPT бачив
// Два сюжети, надіслані в одну хвилину, отримували однаковий ID: у ньому лише
// години й хвилини. Далі все, що шукає рядок за ID, знаходило перший — правки
// й видалення летіли не в той рядок, а відео обох сюжетів претендувало на одне
// й те саме імʼя файлу. Тому перед створенням звіряємося з таблицею і, якщо ID
// зайнятий, додаємо суфікс -2, -3 (так само, як це роблять рядки AUTO-).
export async function uniqueOwnId(now = new Date(), taken = []) {
  const base = ownRowId(now);
  const busy = new Set(taken);
  if (!busy.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    if (!busy.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw new Error(`Не вдалося підібрати вільний ID для ${base}`);
}

// рівно ті фото, які стосуються цієї теми, і не мішав із попередніми.
export async function createSubmission(now = new Date()) {
  // Порожній список ID (наприклад, таблиця недоступна) не має блокувати
  // надсилання: тоді працюємо як раніше, за чистим часом.
  const taken = await readAllItems().then((rows) => rows.map((r) => r.id)).catch(() => []);
  const id = await uniqueOwnId(now, taken);
  const res = await drive().files.create({
    requestBody: {
      name: ownFolderName(id),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId()],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  return { id, folderId: res.data.id, folderUrl: res.data.webViewLink || '' };
}

function safeName(name, index) {
  const clean = String(name || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(-60);
  const ext = /\.(jpe?g|png|webp)$/i.test(clean) ? '' : '.jpg';
  return `${String(index).padStart(2, '0')}-${clean || 'photo'}${ext}`;
}

// Вивантажує одне фото власника. Приймаємо по одному файлу за запит: так
// навіть десяток великих знімків із телефона проходить без гігантського тіла
// запиту, яке легко впирається в ліміти проксі.
export async function addPhoto(folderId, { name, index, data, mimeType }) {
  if (index > MAX_PHOTOS) throw new Error(`Забагато фото — максимум ${MAX_PHOTOS}`);
  const buffer = Buffer.from(String(data || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buffer.length) throw new Error('Порожній файл');
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new Error(`Фото завелике (${Math.round(buffer.length / 1e6)} МБ, ліміт ${MAX_PHOTO_BYTES / 1e6} МБ)`);
  }
  const res = await drive().files.create({
    requestBody: { name: safeName(name, index), parents: [folderId] },
    media: { mimeType: mimeType || 'image/jpeg', body: Readable.from(buffer) },
    fields: 'id, name',
    supportsAllDrives: true,
  });
  return { fileId: res.data.id, name: res.data.name };
}

// Дістає початковий текст власника з промту в колонці G. Потрібен, коли рядок
// упав у ERROR: щоб надіслати сюжет заново, власник має отримати назад те, що
// написав, — у чаті з ботом воно не зберігається. Якщо ChatGPT уже переписав
// колонку своїм шаблоном, лапок не буде і повернеться порожній рядок — тоді
// показуємо розібрані слайди.
export function extractOwnStory(prompt) {
  const m = /«««\s*\n([\s\S]*?)\n\s*»»»/.exec(String(prompt || ''));
  return m ? m[1].trim() : '';
}

// --- Блок «фото власника» в промті -------------------------------------------
// Фото можуть з'явитися і ПІСЛЯ того, як ChatGPT уже розписав сценарій у
// колонці G: власник надіслав текст, а знімки знайшов пізніше. Тому блок
// обгорнутий маркерами — щоб його можна було знайти, замінити на новий (фото
// докинули ще раз) або прибрати зовсім, не зачепивши решту промту.
const PHOTO_START = '——— ФОТО ВЛАСНИКА';
const PHOTO_END = '——— кінець блоку фото ———';
// Крапка з комою в кінці не потрібна: блок завжди закінчується своїм маркером.
const PHOTO_BLOCK_RE = /\n*———[ \t]*ФОТО ВЛАСНИКА[\s\S]*?——— кінець блоку фото ———[ \t]*\n?/g;

// Куди вставляти блок у вже написаному сценарії: перед покадровим брифом, щоб
// ChatGPT прочитав «спершу подивись на фото» ДО опису кадрів, а не після.
const FRAME_ANCHOR = 'ЩО МАЄ БУТИ НА КОЖНОМУ КАДРІ';

export function ownPhotoBlock({ photoCount, where }) {
  return `${PHOTO_START} (${photoCount} шт.) ———
Лежать у папці Drive: ${where}
Пріоритет у них: якщо кадр підходить під слайд хоч приблизно — бери його, а не
малюй новий. Підхожі доведи до формату 1080×1920 (9:16), повна якість, БЕЗ
тексту, верхні 40% кадру спокійні; кадруй, дотягуй світло й різкість, але не
підміняй зміст домальованим. Чого не вистачає — домалюй у тому ж стилі
(світло, колір, оптика як на фото власника). Якщо жодне фото не підійшло —
напиши про це в «Примітці».
${PHOTO_END}`;
}

// Шапка промту ПЕРШОГО етапу (розбити сюжет на слайди) окремо повідомляє, чи
// фото взагалі є. Якщо знімки докинули до того, як ChatGPT відпрацював, шапка
// лишалася б зі старим «фото немає» — і він чесно виконав би написане,
// проігнорувавши папку. Тому рядок шапки тримаємо в курсі разом із блоком.
// У готовому сценарії (другий етап) такої шапки немає — там просто нічого
// не збігається й нічого не міняється.
const NO_PHOTOS_LINE = 'ФОТО НЕМАЄ — усі кадри малюватимуться з нуля.';
const PHOTO_HEADER_RE = /ФОТО ВЛАСНИКА: \d+ шт\. у папці Drive:\n[^\n]*/;

function syncPhotoHeader(text, photoCount, where) {
  const header = `ФОТО ВЛАСНИКА: ${photoCount} шт. у папці Drive:\n${where}`;
  if (photoCount > 0) {
    if (PHOTO_HEADER_RE.test(text)) return text.replace(PHOTO_HEADER_RE, header);
    return text.replace(NO_PHOTOS_LINE, header);
  }
  return text.replace(PHOTO_HEADER_RE, NO_PHOTOS_LINE);
}

// Вставляє (або оновлює) блок фото у промті колонки G. Старий блок завжди
// знімається першим — інакше після другого докидання фото в промті лежало б
// два блоки з різними числами, і ChatGPT вибирав би сам, якому вірити.
// photoCount = 0 просто прибирає блок: так само знімається згадка про фото,
// якщо папку спорожнили.
export function withOwnPhotos(prompt, { photoCount = 0, folderUrl = '', folderName = '' } = {}) {
  const where = folderUrl || folderName || 'папка матеріалів власника';
  const cleaned = syncPhotoHeader(
    String(prompt || '').replace(PHOTO_BLOCK_RE, '\n\n'),
    photoCount,
    where,
  ).trimEnd();
  if (!(photoCount > 0)) return cleaned;
  const block = ownPhotoBlock({ photoCount, where });
  const at = cleaned.indexOf(FRAME_ANCHOR);
  if (at < 0) return `${cleaned}\n\n${block}`;
  return `${cleaned.slice(0, at).trimEnd()}\n\n${block}\n\n${cleaned.slice(at)}`;
}

// --- Папка з матеріалами -----------------------------------------------------
// Назва папки — єдиний звʼязок між рядком таблиці й фото на Drive: ID папки
// ніде не зберігається. Тому шукаємо за ТОЧНОЮ назвою, а не «contains»: інакше
// OWN-20260913-0838 знаходив би й папку OWN-20260913-0838-2.
function ownFolderName(id) {
  return `${id} — матеріали власника`;
}

export async function findOwnFolder(id) {
  const name = ownFolderName(id).replace(/'/g, "\\'");
  const res = await drive().files.list({
    q: `'${parentFolderId()}' in parents and name = '${name}' `
      + "and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id, webViewLink)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const found = (res.data.files || [])[0];
  return found ? { folderId: found.id, folderUrl: found.webViewLink || '' } : null;
}

// Папка під фото для рядка, який її ще не має (сюжет надіслали без знімків або
// це взагалі рядок AUTO-). Створюємо за тією ж домовленістю про назву, тож
// далі він нічим не відрізняється від сюжету, поданого одразу з фото.
export async function ensureOwnFolder(id) {
  const found = await findOwnFolder(id);
  if (found) return found;
  const res = await drive().files.create({
    requestBody: {
      name: ownFolderName(id),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId()],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  return { folderId: res.data.id, folderUrl: res.data.webViewLink || '' };
}

// Скільки знімків у папці НАСПРАВДІ. Рахуємо на Drive, а не з того, що
// надіслав браузер: інакше перерване завантаження лишило б у промті число
// більше за кількість файлів, і ChatGPT шукав би неіснуючі кадри.
export async function countOwnPhotos(folderId) {
  let count = 0;
  let pageToken;
  do {
    const res = await drive().files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`,
      fields: 'nextPageToken, files(id)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    count += (res.data.files || []).length;
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return count;
}

// Промт для ChatGPT під власний матеріал. Свідомо описує ВСІ три випадки —
// текст без фото, фото без тексту, і те й те — щоб не довелося тримати три
// різні шаблони й щоб ChatGPT не імпровізував там, де матеріал є.
export function buildOwnPrompt({ rowId, story, photoCount, folderUrl, folderName }) {
  const hasStory = Boolean(story && story.trim());
  const hasPhotos = photoCount > 0;
  const where = folderUrl || folderName || 'папка матеріалів власника';

  const material = hasStory
    ? `СЮЖЕТ ВІД ВЛАСНИКА (це основа, не переписуй його наново):\n«««\n${story.trim()}\n»»»`
    : 'СЮЖЕТУ НЕМАЄ — власник надіслав лише фото.';

  const photos = hasPhotos
    ? `ФОТО ВЛАСНИКА: ${photoCount} шт. у папці Drive:\n${where}`
    : 'ФОТО НЕМАЄ — усі кадри малюватимуться з нуля.';

  const step1 = hasStory
    ? `1. Розбий сюжет власника на слайди: один слайд = одне закінчене речення,
   5–12 слайдів. Зміст і факти НЕ міняй, порядок думки збережи. Можна
   поправити лише граматику й розбивку на речення. Перший слайд — інтрига
   без відповіді, передостанній — розгадка, останній — коротке питання до
   глядача на «ти».`
    : `1. Подивись на фото власника і придумай за ними тему та сюжет: 5–12
   слайдів, один слайд = одне закінчене речення, жива розмовна українська.
   Перший слайд — інтрига, передостанній — розгадка, останній — питання.`;

  const step2 = hasStory
    ? `2. ПЕРЕВІР ФАКТИ веб-пошуком. Якщо у сюжеті власника є помилка — НЕ
   виправляй мовчки: постав статус ERROR і опиши проблему в «Примітці».`
    : '2. ПЕРЕВІР ФАКТИ веб-пошуком, перш ніж писати цифри й назви.';

  // Блок про фото власника вставляється в СЦЕНАРІЙ, а не виконується зараз:
  // малюватиме другий промт, і саме йому потрібні ці вказівки.
  const photoBlock = hasPhotos ? `\n${ownPhotoBlock({ photoCount, where })}` : '';

  return `ЗАВДАННЯ ВІД ВЛАСНИКА КАНАЛУ «Чи Ви Знали?».

${material}

${photos}

═══════════════════════════════════════
ЗАРАЗ ТИ РОБИШ ЛИШЕ СЦЕНАРІЙ. Фото НЕ малюй, архів НЕ збирай, статус НЕ міняй
на DONE — власник спершу перечитає й поправить тексти в мінідодатку, і аж
потім запустить промт малювання фото.

ПОРЯДОК ДІЙ:
${step1}
${step2}
3. ОНОВИ ЦЕЙ САМИЙ РЯДОК таблиці «Черга тем» (ID: ${rowId}) — НЕ створюй новий:
   • «Тема» (C) — тема, яку ти дав сюжету;
   • «Слайдів» (F) — скільки вийшло слайдів;
   • «Додаткові вказівки» (G) — сценарій за шаблоном нижче, замість цього тексту;
   • «Джерела» (K) — посилання, за якими перевіряв факти, через кому;
   • «Примітка» (L) — коротко: що перевірив і що лишилось під питанням;
   • «Статус» (E) — лишається NEW. Не чіпай.
   Колонки H, J, M, N не заповнюй — це робота другого промту.

ШАБЛОН ДЛЯ КОЛОНКИ G (підстав свої значення замість фігурних дужок):

ЗАТВЕРДЖЕНИЙ СЦЕНАРІЙ. Твоє завдання — ЛИШЕ намалювати фото й зібрати архів. Тему НЕ придумуй, тексти слайдів НЕ змінюй, кількість не змінюй.

ТЕМА: {тема}
КІЛЬКІСТЬ ФОТО: {N}

ТЕКСТИ СЛАЙДІВ (рівно ці рядки й у цьому порядку йдуть у script.txt):
1. {рядок 1}
2. {рядок 2}
{і так далі до N}

ВІЗУАЛЬНИЙ КОНТЕКСТ:
ТИП ІСТОРІЇ: {історична подія / реальне місце / науковий механізм / природне явище}
МІСЦЕ: {країна, область, конкретне місце}
ЧАС/ЕПОХА: {період або «сучасність»}
ГОЛОВНИЙ ОБ'ЄКТ (має лишатися впізнаваним): {що саме}
КЛЮЧОВІ ВІЗУАЛЬНІ ОЗНАКИ: {форма, матеріал, колір, середовище, світло}
НЕ ВИГАДУВАТИ: {деталі, які критично не спотворювати}

ДЖЕРЕЛА: {посилання через кому}
${photoBlock}
ЩО МАЄ БУТИ НА КОЖНОМУ КАДРІ:
1.jpg — {опис кадру 1}
(рядок: «{рядок 1}»)
{і так далі до N}

Наприкінці напиши коротко: яку тему дав сюжету, скільки вийшло слайдів і за якими джерелами перевірив факти.`;
}

// Кладе рядок у таблицю. Кількість слайдів наперед невідома (її визначить
// ChatGPT, розбиваючи сюжет), тому колонку «Слайдів» лишаємо порожньою і
// просимо заповнити її разом зі статусом.
export async function submitOwn({ id, story, photoCount, folderUrl, folderName, theme }) {
  const prompt = buildOwnPrompt({ rowId: id, story, photoCount, folderUrl, folderName });
  await appendQueueRow({
    id,
    theme: theme || (story ? story.trim().slice(0, 80) : 'Сюжет власника за фото'),
    slides: '',
    prompt,
    note: `Матеріал власника: ${photoCount} фото${story ? ' + свій сюжет' : ' без тексту'}`,
  });
  return { id, photoCount };
}

// Чи заносити тему до стоп-листа, коли рядок прибирають.
//
// Стоп-лист існує заради генератора тем: він читає його, щоб не пропонувати
// вдруге те, що власник уже відхилив. Власні сюжети генератор не вигадує —
// їх приносить сам власник, — тож заносити їх туди безглуздо: список росте, а
// впливу нуль. Гірше: власник, який видалив свій сюжет через дрібницю (забув
// фото) і надіслав його наново, отримав би власну ж тему в стоп-листі.
export function blacklistOnReject(id) {
  return !String(id || '').startsWith('OWN-');
}

// Прибирає папку з матеріалами власника (коли він відхилив свій сюжет).
// Шукаємо за назвою: ID папки ніде не збережений, а назва починається з ID
// рядка — цього досить і не вимагає ще одного стану.
export async function deleteOwnFolder(id) {
  const res = await drive().files.list({
    q: `'${parentFolderId()}' in parents and name contains '${id}' `
      + "and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id, name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  let removed = 0;
  for (const f of res.data.files || []) {
    await drive().files.delete({ fileId: f.id, supportsAllDrives: true });
    removed++;
  }
  return removed;
}

// --- Замовлені прізвища ------------------------------------------------------
// Глядачі почали просити розібрати СВОЄ прізвище. Такий рядок іде тим самим
// шляхом, що й сюжет власника (OWN- + пріоритет №1 у промті сценарію), але
// вимагає трьох послаблень, інакше промт його відкине або підмінить тему:
//   • перевірка поширеності — замовлене прізвище часто рідкісне, і це нормально:
//     його чекає конкретна людина, а не «тисячі»;
//   • заборона міняти тему — якщо надійної етимології саме цього прізвища немає,
//     промт наказує взяти іншу. Для замовлення це неприйнятно;
//   • ротація рубрик — рубрику диктує саме прізвище, а не черга.
const SURNAME_RE = /^[\p{L}][\p{L}ʼ'’\- ]{1,39}$/u;

export function normalizeSurname(value) {
  const clean = String(value || '').trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('Порожнє прізвище');
  if (!SURNAME_RE.test(clean)) {
    throw new Error('Схоже, це не прізвище: лише літери, апостроф і дефіс, до 40 символів');
  }
  return clean[0].toUpperCase() + clean.slice(1);
}

export function buildSurnamePrompt({ rowId, surname }) {
  return `ЗАМОВЛЕННЯ ГЛЯДАЧА: прізвище ${surname}.

Зроби про нього ролик за всіма правилами промту сценарію — структура, зачин,
ритм, мова, візуальний план, аудит, колонка G. Але з трьома винятками, бо це
замовлення, а не тема з ротації.

1. ПЕРЕВІРКУ ПОШИРЕНОСТІ НЕ ЗАСТОСОВУЙ. Прізвище може бути рідкісним — його
   замовила конкретна людина, і саме вона його чекає. Правило «не менше
   кількох тисяч носіїв» на цей рядок не діє.
2. ТЕМУ НЕ МІНЯЙ НІ ЗА ЯКИХ УМОВ. Якщо надійної етимології саме цього
   прізвища немає — це не привід узяти інше. Розбери те, що задокументовано:
   корінь, спосіб творення, споріднені прізвища того самого гнізда. Прямо
   скажи в тексті, що єдиної версії немає, і покажи, що відомо напевно.
   Чесне «точно невідомо, але корінь означав ось це» — нормальний ролик.
   Вигадана красива версія — брак.
3. РУБРИКУ обери за самим прізвищем (П1 ремесло, П2 прізвисько, П3
   прийшлість), ротацію на цей рядок не поширюй. У примітці все одно
   постав рядки РУБРИКА / ГАЧОК / ФІНАЛ · ТОН, як завжди.

ЩО ОБОВ'ЯЗКОВО З'ЯСУВАТИ:
• від якого кореня походить і що це слово означало;
• як утворене — суфікс, усічення, здрібнення — і що це каже про предка;
• скільки людей носить його сьогодні і в яких областях густіше;
• найдавніша письмова згадка, якщо вона є.

ЯКЩО КОРІНЬ ДІАЛЕКТНИЙ АБО ЗАБУТИЙ — це найцікавіше в ролику, а не проблема.
Поясни, що слово означало в говірці, де так казали й чому воно зникло з
літературної мови.

ЗАБОРОНЕНО: вигадувати значення за співзвучністю; тлумачити вдачу чи долю
носіїв; брати пояснення із сайтів-генераторів «значення прізвища».

ОПИС ДЛЯ СОЦМЕРЕЖ (колонка N) роби як завжди. Про те, що ролик замовлений,
не пиши: глядачеві це нічого не додає, а заклик писати своє прізвище в
коментарях у промті й так обов'язковий для кожного ролика.

ОНОВИ ЦЕЙ САМИЙ РЯДОК (ID: ${rowId}), нового не створюй. Статус лишається NEW.`;
}

export async function submitSurname({ surname, now = new Date() }) {
  const clean = normalizeSurname(surname);
  // Замовлення йдуть підряд, тож збіг хвилини тут навіть імовірніший, ніж у
  // сюжетах: ID так само має бути унікальним.
  const taken = await readAllItems().then((rows) => rows.map((r) => r.id)).catch(() => []);
  const id = await uniqueOwnId(now, taken);
  await appendQueueRow({
    id,
    category: 'Замовлення / прізвище',
    theme: `Звідки походить прізвище ${clean}`,
    slides: '',
    prompt: buildSurnamePrompt({ rowId: id, surname: clean }),
    note: `Замовлення глядача: ${clean}. Поширеність не перевіряти, тему не міняти.`,
  });
  return { id, surname: clean };
}
