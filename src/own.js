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
import { appendQueueRow } from './sheets.js';
import { promptFolderId, kyivToday, kyivMinutes } from './kyiv.js';

// Куди складати матеріали власника. За замовчуванням — та сама папка, де
// лежить drafts.json, щоб не заводити ще одну змінну оточення.
function parentFolderId() {
  return process.env.OWN_FOLDER_ID || promptFolderId();
}

const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

// ID рядка для власного сюжету: OWN-YYYYMMDD-HHMM (щоб не плутати з AUTO-).
export function ownRowId(now = new Date()) {
  const ymd = kyivToday(now).replace(/-/g, '');
  const m = kyivMinutes(now);
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
  return `OWN-${ymd}-${hhmm}`;
}

// Створює папку під один сюжет. Окрема папка на кожен — щоб ChatGPT бачив
// рівно ті фото, які стосуються цієї теми, і не мішав із попередніми.
export async function createSubmission(now = new Date()) {
  const id = ownRowId(now);
  const res = await drive().files.create({
    requestBody: {
      name: `${id} — матеріали власника`,
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
    : 'ФОТО НЕМАЄ — усі кадри малюєш сам.';

  const withStory = hasStory
    ? `1. Візьми сюжет власника і розбий його на слайди: один слайд = одне
   закінчене речення, 5–10 слайдів. Зміст і факти НЕ міняй, порядок думки
   збережи. Можна поправити лише граматику й розбивку на речення.
   Перший слайд — інтрига без відповіді, передостанній — розгадка,
   останній — коротке питання до глядача на «ти».
2. ПЕРЕВІР ФАКТИ веб-пошуком. Якщо у сюжеті власника є помилка — НЕ виправляй
   мовчки: постав статус ERROR і опиши проблему в «Примітці».`
    : `1. Подивись на фото власника і придумай за ними тему та сюжет: 5–10
   слайдів, один слайд = одне закінчене речення, жива розмовна українська.
   Перший слайд — інтрига, передостанній — розгадка, останній — питання.
2. ПЕРЕВІР ФАКТИ веб-пошуком, перш ніж писати цифри й назви.`;

  const withPhotos = hasPhotos
    ? `3. РОЗБЕРИСЯ З ФОТО ВЛАСНИКА — це головне в цьому завданні.
   • Переглянь усі ${photoCount} фото в папці й виріши, які з них підходять
     під слайди. Порядок слайдів важливіший за порядок файлів.
   • Підхожі — доведи до нашого формату: 1080×1920 (9:16), повна якість,
     БЕЗ будь-якого тексту, верхні 40% кадру візуально спокійні. Кадруй,
     дотягуй світло й різкість, але не підміняй зміст фото домальованим.
   • Фото власника мають пріоритет: якщо кадр підходить хоч приблизно —
     бери його, а не малюй новий.
   • Чого не вистачає до потрібної кількості — домалюй у тому ж стилі, щоб
     серія виглядала цілісно (світло, колір, оптика як на фото власника).
   • Якщо жодне фото не підійшло — знайди реальні референси й намалюй усе,
     але в «Примітці» напиши, чому фото не використані.`
    : `3. Фото власника немає — знайди реальні фото-референси теми і намалюй
   УСІ кадри сам: 1080×1920 (9:16), один стиль, реалістично,
   кінематографічно, БЕЗ тексту, верхні 40% кадру спокійні.`;

  return `ЗАВДАННЯ ВІД ВЛАСНИКА КАНАЛУ «Чи Ви Знали?».

${material}

${photos}

═══════════════════════════════════════
ПОРЯДОК ДІЙ:
${withStory}
${withPhotos}
4. Зведена картинка — сітка з підписами 1…N (для перегляду оком).
5. АРХІВ .zip: фото «1.jpg»…«N.jpg» (повна якість, порядок слайдів) +
   «script.txt» — тексти слайдів ПО ОДНОМУ РЯДКУ НА ФОТО (рядок 1 → 1.jpg,
   …), без нумерації, описів і розмітки. Інших файлів в архіві нема.
6. Завантаж ZIP у папку Google Drive.
7. ОНОВИ ЦЕЙ САМИЙ РЯДОК таблиці «Черга тем» (ID: ${rowId}) — НЕ створюй новий:
   • «Тема» — тема, яку ти дав сюжету;
   • «Слайдів» — скільки вийшло слайдів;
   • «Архів» — посилання на ZIP;
   • «Назва публікації» — заголовок для соцмереж;
   • «Опис для соцмереж» — гачок, коротке пояснення факту, запитання
     аудиторії, заклик підписатись і рівно 5 хештегів;
   • «Статус» — заміни NEW на DONE.
   Решту колонок НЕ чіпай і НЕ очищай — зокрема «Додаткові вказівки» (G),
   де лежить цей промт.

ПЕРЕД ЗАВАНТАЖЕННЯМ ПЕРЕЛІЧИ ВГОЛОС І ЗВІР:
• скільки файлів-зображень в архіві;
• скільки рядків у script.txt — має бути РІВНО стільки ж;
• скільки з них — фото власника, а скільки домальовано;
• чи це тексти саме цього сюжету.
Не збіглося — перезбери архів, а не завантажуй як є.`;
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
