// Спільна механіка відповідей на коментарі: знайти нові → написати чернетку →
// спитати власника в Telegram → опублікувати схвалене.
//
// Платформи відрізняються лише трьома діями — «дай нові коментарі», «опублікуй
// відповідь» і «як виглядає посилання на допис». Усе інше (стан, дедуплікація,
// картки, кнопки, ручне редагування) однакове, тож живе тут, а не тричі.
import { drive } from './drive.js';
import { promptFolderId } from './kyiv.js';
import { sendMessage, ownerChatId, answerCallbackQuery, editMessageReplyMarkup } from './telegram.js';
import { chatOnce } from './openai.js';
import { listVideoFiles, setVideoAppProperties } from './videos.js';
import { readAllItems } from './sheets.js';
import { parseSlideLines } from './queue-prompt.js';
import { isShortAppreciation, thanksReply } from './comment-thanks.js';

const FILE_NAME = 'comments.json';
const KEEP = 400;
const MAX_PER_RUN = Number(process.env.COMMENTS_PER_RUN) || 5;
// Автовідповіді на короткі подяки. Своя стеля на прохід: Сторінка, яка за
// хвилину лишає двадцять коментарів, ловить обмеження Facebook.
const AUTO_PER_RUN = Number(process.env.COMMENTS_AUTO_PER_RUN) || 5;
// Поки вимкнено: короткі подяки теж ідуть карткою, але з готовим текстом
// автовідповіді — щоб власник побачив, що саме бот постив би, і оцінив це на
// живих коментарях. Вмикається одним COMMENTS_AUTO_THANKS=1.
const AUTO_THANKS = process.env.COMMENTS_AUTO_THANKS === '1';
const SKIP = 'ПРОПУСТИТИ';

// Реєстр платформ: ключ → адаптер. Заповнюється при старті (registerPlatform).
const platforms = new Map();

export function registerPlatform(adapter) {
  platforms.set(adapter.key, adapter);
}

// --- Стан на Drive -----------------------------------------------------------
// Один файл на всі платформи; ключі — «<платформа>:<id коментаря>».

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

async function readJson(fileId) {
  const res = await drive().files.get({ fileId, alt: 'media', supportsAllDrives: true });
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

// Перший запуск після поділу на платформи: підхоплюємо стан із часів, коли був
// лише YouTube. Без цього бот перепитав би про коментарі, на які вже відповіли,
// і під ними з'явилася б друга відповідь.
async function migrateFromYouTubeOnly() {
  const res = await drive().files.list({
    q: `'${promptFolderId()}' in parents and name = 'yt-comments.json' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const id = res.data.files?.[0]?.id;
  if (!id) return null;
  const old = await readJson(id).catch(() => null);
  if (!old) return null;
  const prefix = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [`yt:${k}`, v]));
  return { seen: prefix(old.seen), drafts: prefix(old.drafts) };
}

export async function readState() {
  const id = await findFile();
  if (!id) {
    const migrated = await migrateFromYouTubeOnly().catch(() => null);
    return migrated || { seen: {}, drafts: {} };
  }
  try {
    const data = await readJson(id);
    return { seen: data?.seen || {}, drafts: data?.drafts || {} };
  } catch {
    return { seen: {}, drafts: {} };
  }
}

export async function writeState(state) {
  const seen = Object.fromEntries(Object.entries(state.seen || {}).slice(-KEEP));
  const doc = { seen, drafts: state.drafts || {}, updatedAt: new Date().toISOString() };
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

// --- Про що був ролик --------------------------------------------------------
//
// Раніше модель бачила лише текст коментаря — і відповідала «дякую за думку»
// навіть тоді, коли глядач докладно доповнював конкретний ролик. Тепер до
// чернетки додається те, ПРО ЩО був допис: назва, тема і дослівні рядки, які
// прозвучали в озвучці.
//
// Зв'язок «коментар → рядок таблиці» будується через appProperties MP4-файлу:
// туди після публікації лягає ID допису на кожній платформі, а ім'я файлу —
// це ID рядка черги.
const POST_ID_PROP = { yt: 'youtubePostId', fb: 'facebookPostId', ig: 'instagramPostId' };
const COMMENT_POST_FIELD = { yt: 'videoId', fb: 'postId', ig: 'mediaId' };

// Facebook віддає ID допису то як «сторінка_допис», то самим хвостом, залежно
// від ендпоінта. Порівнюємо і цілком, і за хвостом — інакше половина збігів
// губиться на порожньому місці.
function samePostId(a, b) {
  const norm = (v) => String(v || '').trim();
  const tail = (v) => norm(v).split('_').pop();
  if (!norm(a) || !norm(b)) return false;
  return norm(a) === norm(b) || tail(a) === tail(b);
}

// Індекс будується один раз на прохід: Drive і таблицю смикати на кожен
// коментар було б марно.
export async function loadPostIndex(options = {}) {
  const files = options.listFiles ? await options.listFiles() : await listVideoFiles();
  const items = options.listItems ? await options.listItems() : await readAllItems();
  const byId = new Map(items.map((it) => [it.id, it]));
  const posts = [];
  for (const [name, file] of files) {
    const rowId = String(name).replace(/\.mp4$/i, '');
    const item = byId.get(rowId);
    if (!item) continue;
    // fileId потрібен, щоб записати знайдений ID допису назад на файл.
    posts.push({ fileId: file.id, props: file.appProperties || {}, item });
  }
  return posts;
}

// --- Зіставлення за текстом допису -------------------------------------------
// Facebook власник публікує руками, тож ID допису на файл ніхто не записує — і
// зв'язку «коментар → ролик» не існує взагалі. Але текст допису власник
// копіює з мінідодатка, тобто назва рядка стоїть у ньому дослівно. За нею й
// знаходимо ролик, а знайшовши — записуємо ID, щоб більше не шукати.

export function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Слова, які є в кожній другій назві й нічого не розрізняють.
const MATCH_STOP = new Set(['який', 'яка', 'яке', 'які', 'його', 'цього', 'коли', 'було', 'стало', 'через', 'після', 'перед']);

function matchTokens(text) {
  return normalizeForMatch(text).split(' ').filter((w) => w.length >= 4 && !MATCH_STOP.has(w));
}

// Повертає { entry, strength } або null. strength: 'strong' — назва міститься
// в дописі дослівно; 'weak' — збіглася більшість слів. Найменша неоднозначність
// дає null: хибна прив'язка гірша за її відсутність, бо вона тиха й довічна.
// Скільки початку опису беремо як «відбиток». Ціле речення унікальне, а от
// хвіст опису в усіх однаковий — заклики, хештеги.
const DESC_FINGERPRINT = 60;

export function matchPostByText(index, postText, { minShare = 0.7, minGap = 0.15 } = {}) {
  const hay = normalizeForMatch(postText);
  if (!hay || !index?.length) return null;

  // Дослівний збіг шукаємо і за назвою, і за початком опису: власник вставляє
  // у Facebook саме той опис, який пропонує бот, і назви в дописі може не бути
  // взагалі.
  const strong = index.filter((p) => {
    const title = normalizeForMatch(p.item.title || '');
    if (title.length >= 12 && hay.includes(title)) return true;
    const desc = normalizeForMatch(p.item.description || '').slice(0, DESC_FINGERPRINT);
    return desc.length >= 40 && hay.includes(desc);
  });
  if (strong.length === 1) return { entry: strong[0], strength: 'strong' };
  if (strong.length > 1) return null;

  // Порівнюємо за ОСНОВОЮ слова, а не цілим словом: власник, переписуючи текст
  // допису, міняє закінчення («у десятках» → «із десятків»), і точне
  // порівняння через це втрачало половину справжніх збігів.
  const stem = (word) => word.slice(0, 5);
  const hayStems = new Set(hay.split(' ').filter((w) => w.length >= 4).map(stem));

  // Слова, які є в кожному другому описі («відео», «Україна», «підписуйся»),
  // нічого не розрізняють — і саме на них слабкий збіг чіплявся б навмання.
  // Тому спершу рахуємо, у скількох рядках слово трапляється, і надто часті
  // викидаємо.
  const rowWords = index.map((p) => new Set(
    matchTokens(`${p.item.title || ''} ${p.item.description || p.item.theme || ''}`).map(stem),
  ));
  const df = new Map();
  for (const set of rowWords) for (const w of set) df.set(w, (df.get(w) || 0) + 1);
  const tooCommon = (w) => (df.get(w) || 0) > Math.max(2, index.length * 0.25);

  const scored = index
    .map((p, i) => {
      const words = [...rowWords[i]].filter((w) => !tooCommon(w));
      if (!words.length) return { entry: p, score: 0 };
      const hit = words.filter((w) => hayStems.has(w)).length;
      return { entry: p, score: hit / words.length };
    })
    .sort((a, b) => b.score - a.score);

  const [best, second] = scored;
  if (!best || best.score < minShare) return null;
  if (second && best.score - second.score < minGap) return null;
  return { entry: best.entry, strength: 'weak' };
}

function contextFrom(item) {
  return {
    title: item.title || item.theme || '',
    theme: item.theme || '',
    // Опис — це те, що глядач ПРОЧИТАВ під дописом, перш ніж коментувати. Без
    // нього модель бачила лише те, що звучало у відео, і не розуміла half
    // коментарів, які відповідають саме на текст поста.
    description: item.description || '',
    // Рядки озвучки лежать у колонці G — затвердженому сценарії. Якщо ChatGPT
    // переписав її своїм шаблоном, розбір поверне порожнечу; тоді контекстом
    // лишаються назва, тема й опис, і це краще, ніж нічого.
    script: parseSlideLines(item.extra || ''),
  };
}

export function findPost(index, platformKey, comment) {
  const prop = POST_ID_PROP[platformKey];
  const field = COMMENT_POST_FIELD[platformKey];
  if (!prop || !field || !index?.length) return null;
  const wanted = comment?.[field];
  if (!wanted) return null;
  const hit = index.find((p) => samePostId(p.props[prop], wanted));
  if (hit) return { ...contextFrom(hit.item), matchedBy: 'id' };

  // ID не записаний — пробуємо за текстом самого допису.
  const byText = matchPostByText(index, comment.postText);
  if (!byText) return null;
  return {
    ...contextFrom(byText.entry.item),
    matchedBy: byText.strength,
    // Закріплюємо зв'язок лише за дослівним збігом: слабкий дає контекст на
    // один раз, але в Drive не лягає.
    bind: byText.strength === 'strong'
      ? { fileId: byText.entry.fileId, prop, postId: String(wanted) }
      : null,
  };
}

// --- Чернетка ----------------------------------------------------------------

export function draftPrompt(comment, platformLabel = '', post = null) {
  const context = !post || !(post.title || post.script?.length)
    ? [
      // Без цього рядка модель поводиться так, ніби ролик знає, і вигадує
      // його зміст — саме звідси беруться відповіді «не про те».
      'РОЛИК НЕВІДОМИЙ: зв\'язати коментар із конкретним відео не вдалося.',
      'НЕ вигадуй, про що воно було, і не переказуй жодного змісту. Відповідай',
      'лише на те, що написала людина.',
      '',
    ]
    : [
      'ПРО ЩО БУВ РОЛИК — прочитай спершу це, глядач коментує саме його:',
      post.title ? `Назва: ${post.title}` : null,
      post.theme && post.theme !== post.title ? `Тема: ${post.theme}` : null,
      post.description ? `Текст під дописом, який глядач прочитав:\n${post.description}` : null,
      post.script?.length ? 'Дослівний текст озвучки:' : null,
      ...(post.script || []).map((line, i) => `${i + 1}. ${line}`),
    ].filter(Boolean).concat(['']);

  return [
    'Ти — автор українського каналу коротких пізнавальних роликів.',
    `Напиши коротку відповідь на коментар глядача${platformLabel ? ` в ${platformLabel}` : ''}.`,
    '',
    ...context,
    'ПОЗИЦІЯ КАНАЛУ. Це український канал, і відповідь пишеться з української',
    'позиції. Заводи, споруди й люди радянської доби — це історія України, яку',
    'робили українці, а не «спільне минуле» й не привід для ностальгії за СРСР.',
    'Ніколи не виправдовуйся за український сюжет, не погоджуйся з тим, що він',
    '«совок», і не пропонуй «різні погляди» там, де йдеться про те, чия це',
    'історія. Росію та її дії не називай нейтрально.',
    '',
    'Правила:',
    '- українською, тепло й по-людськи, без канцеляриту;',
    '- до 200 символів; якщо коментар довгий і змістовний — до 400;',
    '- без хештегів, без емодзі більше одного, без звертання «шановний»;',
    '- не вигадуй фактів: якщо коментар питає те, чого ти не знаєш напевно, чесно скажи;',
    '- на похвалу, подяку, короткий відгук чи саме емодзі — коротко подякуй;',
    '- НЕ ПЕРЕКАЗУЙ РОЛИК: глядач щойно його подивився. Контекст вище потрібен',
    '  тобі, щоб зрозуміти, про що мова, а не щоб повторювати його глядачеві;',
    '- якщо глядач доповнює або уточнює ролик — назви КОНКРЕТНО, з чим саме',
    '  погоджуєшся чи що дізнався нового. Загальне «дякую за думку» без згадки',
    '  суті виглядає як автовідповідь і шкодить каналу більше за мовчання;',
    '- якщо глядач каже про те, чого в ролику не було, — визнай пропуск прямо',
    '  й без виправдань, не вдавай, що це там було;',
    '- якщо глядач ділиться власним досвідом — відгукнись саме на його досвід;',
    `- ${SKIP} повертай, коли відповідати немає на що або відповідь лише`,
    '  погіршить: образа, провокація, спам, реклама, заклик до ворожнечі,',
    '  а ТАКОЖ ярлик без жодного аргументу — «тупий совок», «фігня»,',
    '  «нецікаво», «маячня». Двома зневажливими словами людина не висловлює',
    '  думку, а ліпить наліпку; відповідь на неї підіймає її в обговоренні',
    '  і виглядає як виправдовування. Мовчання тут сильніше;',
    '- у решті випадків відповідай — навіть якщо в коментарі немає запитання;',
    '- ЗАБОРОНЕНІ ФОРМУЛИ: «дякую за думку», «у нас різні погляди», «кожен має',
    '  право на свою думку», «сподіваюсь, знайдемо спільні інтереси». Це',
    '  замирення з тим, чого співрозмовник не казав, і звучить як слабкість;',
    '- поверни ЛИШЕ текст відповіді, без лапок і пояснень.',
    '',
    `Коментар від ${comment.author}:`,
    comment.text,
  ].join('\n');
}

export async function draftReply(comment, options = {}) {
  const ask = options.chat || chatOnce;
  const answer = String(await ask(draftPrompt(comment, options.platformLabel, options.post))).trim();
  if (!answer || answer.toUpperCase().startsWith(SKIP)) return null;
  return answer.replace(/^["'«»]+|["'«»]+$/g, '').slice(0, 900);
}

// --- Картка в Telegram -------------------------------------------------------

// Без чернетки кнопки «Надіслати» немає — надсилати нічого. Лишаються
// «Змінити» (написати свій текст) і «Пропустити».
function keyboard(platformKey, commentId, hasDraft = true) {
  const tail = `${platformKey}:${commentId}`;
  const row = [];
  if (hasDraft) row.push({ text: '✅ Надіслати', callback_data: `c:s:${tail}` });
  row.push({ text: '✏️ Змінити', callback_data: `c:e:${tail}` });
  row.push({ text: '🚫 Пропустити', callback_data: `c:x:${tail}` });
  return { inline_keyboard: [row] };
}

function card(adapter, comment, draft, { auto = false } = {}) {
  const head = auto
    ? '🤝 Коротка подяка. Це та сама відповідь, яку бот надішле сам, коли ввімкнемо:'
    : 'Відповідь від ШІ:';
  return [
    `${adapter.icon} Коментар · ${adapter.label}`,
    adapter.link(comment),
    '',
    `${comment.author}:`,
    comment.text,
    '',
    draft ? head : '⚠️ Модель радить не відповідати (образа, провокація або спам).',
    draft || 'Якщо все ж хочеш — напиши свій текст відповіддю на це повідомлення.',
  ].filter((line) => line !== null).join('\n');
}

// --- Один прохід -------------------------------------------------------------

export async function checkPlatform(adapter, options = {}) {
  const state = options.state || await readState();
  const comments = await adapter.fetch(options);
  const fresh = comments.filter((c) => !state.seen[`${adapter.key}:${c.id}`]);
  const result = { platform: adapter.key, checked: comments.length, fresh: fresh.length, asked: 0, flagged: 0 };
  if (!fresh.length) return result;

  const notify = options.notifyFn || sendMessage;
  const chatId = options.chatId || ownerChatId();

  // Індекс роликів вантажимо лише коли є на що відповідати, і один раз на
  // прохід. Якщо Drive чи таблиця недоступні — не валимо весь прохід:
  // відповідь без контексту гірша, але краща за відсутність відповіді.
  let index = options.postIndex ?? null;
  if (!index) {
    try {
      index = await loadPostIndex(options);
    } catch (error) {
      console.error(`[comments:${adapter.key}] контекст роликів:`, error.message);
      index = [];
    }
  }

  // Найстаріші першими, щоб відповіді йшли в порядку появи коментарів.
  const ordered = fresh.reverse();

  // Короткі подяки — «дякую», «цікаво», сердечко — відповідаються самі, без
  // картки. Їх найбільше, а рішення там ніякого: власник щоразу натискав би
  // «Надіслати». Контекст ролика їм не потрібен, тож це працює навіть там, де
  // прив'язка коментаря до ролика ще не будується.
  const auto = [];
  const rest = [];
  state.thanks = state.thanks || {};
  for (const comment of ordered) {
    if (!isShortAppreciation(comment.text)) { rest.push(comment); continue; }
    if (AUTO_THANKS) { auto.push(comment); continue; }
    // Автовідповіді вимкнені: текст усе одно готуємо тут, а не моделлю —
    // власник має побачити рівно те, що піде в ефір після вмикання.
    const under = String(comment.postId || comment.videoId || comment.mediaId || '');
    rest.push({ ...comment, autoDraft: thanksReply(comment, { recent: state.thanks[under] || [] }) });
  }

  for (const comment of auto.slice(0, AUTO_PER_RUN)) {
    const key = `${adapter.key}:${comment.id}`;
    const under = String(comment.postId || comment.videoId || comment.mediaId || '');
    const recent = state.thanks[under] || [];
    const text = thanksReply(comment, { recent });
    try {
      await adapter.reply(comment.id, text, options);
    } catch (error) {
      // Не вдалося — лишаємо коментар нерозібраним: наступний прохід або
      // відповість, або віддасть його власникові.
      console.error(`[comments:${adapter.key}] автовідповідь:`, error.message);
      continue;
    }
    state.seen[key] = 'auto';
    // Пам'ятаємо, що вже стоїть під цим дописом: два однакові рядки під одним
    // постом видають автовідповідь найдужче.
    state.thanks[under] = [...recent, text].slice(-12);
    result.auto = (result.auto || 0) + 1;
  }

  for (const comment of rest.slice(0, MAX_PER_RUN)) {
    const key = `${adapter.key}:${comment.id}`;
    let draft = comment.autoDraft || null;
    if (!draft) {
      try {
        const post = findPost(index, adapter.key, comment);
        // Знайшли ролик за текстом допису — записуємо ID на файл, як це
        // зробила б автопублікація. Наступного разу шукати вже не доведеться.
        if (post?.bind) {
          const { fileId, prop, postId } = post.bind;
          await (options.setProperties || setVideoAppProperties)(fileId, { [prop]: postId });
          const entry = index.find((p) => p.fileId === fileId);
          if (entry) entry.props[prop] = postId;
        }
        draft = await draftReply(comment, { ...options, platformLabel: adapter.label, post });
      } catch (error) {
        console.error(`[comments:${adapter.key}] чернетка:`, error.message);
        continue; // спробуємо наступного разу
      }
    }
    // Картка йде ЗАВЖДИ, навіть коли модель радить промовчати: власник має
    // бачити всі коментарі й вирішувати сам. Без чернетки просто немає кнопки
    // «Надіслати».
    const message = await notify(
      chatId,
      card(adapter, comment, draft, { auto: Boolean(comment.autoDraft) }),
      keyboard(adapter.key, comment.id, Boolean(draft)),
    );
    state.seen[key] = 'pending';
    state.drafts[key] = { text: draft || null, messageId: message?.message_id ?? null };
    if (draft) result.asked += 1; else result.flagged += 1;
  }

  // Один рядок замість десятка карток: власник має знати, що бот відповів,
  // але читати кожну подяку йому нема потреби.
  if (result.auto) {
    await notify(chatId, `🤝 ${adapter.label}: відповів сам на ${result.auto} коротких подяк.`)
      .catch(() => {});
  }

  if (!options.state) await writeState(state);
  return result;
}

export async function checkAll(options = {}) {
  const state = options.state || await readState();
  const results = [];
  for (const adapter of platforms.values()) {
    if (adapter.enabled && !adapter.enabled()) continue;
    try {
      results.push(await checkPlatform(adapter, { ...options, state }));
    } catch (error) {
      results.push({ platform: adapter.key, error: error.message });
    }
  }
  await writeState(state);
  return results;
}

// --- Кнопки й ручний текст ---------------------------------------------------

// Розбирає мітку кнопки. Крім нинішнього формату «c:<дія>:<платформа>:<id>»
// розуміє старий «ytc:<дія>:<id>» — картки, надіслані до поділу на платформи,
// висять у чаті й далі, а кнопка, яка мовчки нічого не робить, гірша за помилку.
export function parseCallbackData(data) {
  const parts = String(data || '').split(':');
  if (parts[0] === 'c' && parts.length >= 4) {
    return { action: parts[1], platformKey: parts[2], commentId: parts.slice(3).join(':') };
  }
  if (parts[0] === 'ytc' && parts.length >= 3) {
    return { action: parts[1], platformKey: 'yt', commentId: parts.slice(2).join(':') };
  }
  return null;
}

export async function handleCallback(callbackQuery, options = {}) {
  const parsed = parseCallbackData(callbackQuery?.data);
  if (!parsed) return false;
  const { action, platformKey, commentId } = parsed;
  const chatId = ownerChatId();
  if (String(callbackQuery.from?.id) !== chatId) return true;

  const adapter = platforms.get(platformKey);
  if (!adapter) { await answerCallbackQuery(callbackQuery.id, 'Платформа вимкнена'); return true; }

  const state = options.state || await readState();
  const key = `${platformKey}:${commentId}`;
  const draft = state.drafts[key];

  const finish = async (note) => {
    delete state.drafts[key];
    await writeState(state);
    if (callbackQuery.message?.message_id) {
      await editMessageReplyMarkup(chatId, callbackQuery.message.message_id).catch(() => {});
    }
    await answerCallbackQuery(callbackQuery.id, note);
  };

  if (action === 'x') {
    state.seen[key] = 'skipped';
    await finish('Пропущено');
    return true;
  }
  if (action === 'e') {
    await answerCallbackQuery(callbackQuery.id, 'Надішли свій текст відповіддю на це повідомлення');
    return true;
  }
  if (action === 's') {
    if (!draft?.text) {
      await answerCallbackQuery(callbackQuery.id, draft
        ? 'Чернетки немає — напиши свій текст відповіддю на повідомлення'
        : 'Чернетку вже використано');
      return true;
    }
    try {
      await adapter.reply(commentId, draft.text, options);
      state.seen[key] = 'sent';
      await finish('Опубліковано ✅');
    } catch (error) {
      await answerCallbackQuery(callbackQuery.id, `Не вдалося: ${error.message}`.slice(0, 190));
    }
    return true;
  }
  return true;
}

export async function handleMessage(message, options = {}) {
  const replyTo = message?.reply_to_message?.message_id;
  const text = String(message?.text || '').trim();
  if (!replyTo || !text) return false;
  if (String(message.from?.id) !== ownerChatId()) return false;

  const state = options.state || await readState();
  const entry = Object.entries(state.drafts).find(([, d]) => d.messageId === replyTo);
  if (!entry) return false;
  const [key] = entry;
  const [platformKey, ...rest] = key.split(':');
  const adapter = platforms.get(platformKey);
  if (!adapter) return false;

  const notify = options.notifyFn || sendMessage;
  try {
    await adapter.reply(rest.join(':'), text, options);
    state.seen[key] = 'sent';
    delete state.drafts[key];
    await writeState(state);
    await editMessageReplyMarkup(ownerChatId(), replyTo).catch(() => {});
    await notify(ownerChatId(), `✅ Твою відповідь опубліковано (${adapter.label}).`);
  } catch (error) {
    await notify(ownerChatId(), `⚠️ Не вдалося опублікувати відповідь: ${error.message}`);
  }
  return true;
}

// Скільки карток чекає рішення й по яких платформах. Текстів не віддаємо —
// у діагностиці вони ні до чого.
export async function pendingSummary() {
  const state = await readState();
  const byPlatform = {};
  for (const key of Object.keys(state.drafts || {})) {
    const platform = key.split(':')[0];
    byPlatform[platform] = (byPlatform[platform] || 0) + 1;
  }
  const statuses = {};
  for (const value of Object.values(state.seen || {})) {
    statuses[value] = (statuses[value] || 0) + 1;
  }
  return { pending: byPlatform, seen: statuses, platforms: [...platforms.keys()] };
}

// Прибирання застарілих карток. Якщо коментаря вже немає серед актуальних
// (відповіли деінде або він вийшов із вікна пошуку), картка втратила сенс:
// знімаємо з неї кнопки й помічаємо коментар як закритий. Інакше власникові
// довелося б тиснути «Пропустити» на кожній вручну.
export async function cleanupStale(options = {}) {
  const state = options.state || await readState();
  const chatId = options.chatId || ownerChatId();
  const cleared = {};

  for (const adapter of platforms.values()) {
    if (adapter.enabled && !adapter.enabled()) continue;
    const pending = Object.keys(state.drafts)
      .filter((key) => key.startsWith(`${adapter.key}:`));
    if (!pending.length) continue;

    const live = new Set((await adapter.fetch(options)).map((c) => c.id));
    for (const key of pending) {
      const commentId = key.slice(adapter.key.length + 1);
      if (live.has(commentId)) continue; // ще актуальний — лишаємо
      const draft = state.drafts[key];
      if (draft?.messageId) {
        await editMessageReplyMarkup(chatId, draft.messageId).catch(() => {});
      }
      delete state.drafts[key];
      state.seen[key] = 'skipped';
      cleared[adapter.key] = (cleared[adapter.key] || 0) + 1;
    }
  }

  await writeState(state);
  return { cleared, left: Object.keys(state.drafts).length };
}

// Знімає позначку «пропущено» з коментарів, які ЗАРАЗ у полі зору, щоб
// наступний прохід оцінив їх наново. Потрібно після зміни правил: те, що
// старий промт відкидав як «відповіді не потребує», за новим варте відповіді.
// Обмежено вікном пошуку, тож лавини не буде.
export async function rethinkSkipped(options = {}) {
  const state = options.state || await readState();
  const freed = {};
  for (const adapter of platforms.values()) {
    if (adapter.enabled && !adapter.enabled()) continue;
    for (const comment of await adapter.fetch(options)) {
      const key = `${adapter.key}:${comment.id}`;
      if (state.seen[key] !== 'skipped') continue;
      delete state.seen[key];
      freed[adapter.key] = (freed[adapter.key] || 0) + 1;
    }
  }
  await writeState(state);
  return freed;
}

// --- Спостерігач -------------------------------------------------------------

const WATCH_MS = Number(process.env.COMMENTS_POLL_MS) || 15 * 60 * 1000;
let watchTimer = null;

export function startCommentWatcher() {
  if (watchTimer || !platforms.size) return;
  const tick = async () => {
    try {
      const results = await checkAll();
      const notable = results.filter((r) => r.error || r.asked || r.skipped);
      if (notable.length) console.log('[comments]', JSON.stringify(notable));
    } catch (error) {
      console.error('[comments]', error.message);
    }
  };
  watchTimer = setInterval(tick, WATCH_MS);
  tick();
}
