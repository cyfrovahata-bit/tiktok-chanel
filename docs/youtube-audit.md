# Заявка на аудит YouTube API — готові відповіді

Форма: https://support.google.com/youtube/contact/yt_api_form?hl=en
Подавати **з основного акаунта**, якому належить проєкт Google Cloud `tiktok-chanel`.

У квадратних дужках — те, що можу заповнити тільки ти. Решту копіюй як є.
Форма приймає лише англійську.

---

## Section 1: Request Type

> **Complete a compliance audit to request for additional quota**

Другий варіант — тільки для тих, кого Google сам попросив перепройти аудит.
Нам додаткова квота не потрібна, але це єдиний шлях подати аудит уперше;
у секції 5 чесно пишемо, що вистачає стандартної.

---

## Section 2: Organization and Contact Information

| Поле | Значення |
|---|---|
| Application type | Individual |
| Your Full Legal Name | [твоє повне ім'я латиницею, як у паспорті] |
| Your Organization's Legal Name | Individual — no registered legal entity |
| Parent company | — (лишити порожнім) |
| Primary Website | `https://tiktok-chanel-production.up.railway.app/about` |
| Country | Ukraine |
| Street / City / Postal code | [твоя адреса] |
| Primary business focus | Media & Entertainment — content creation |
| Organization size | 1 (sole operator) |
| Primary / technical / business contact | [твоє ім'я], cyfrovahata@gmail.com — усюди одне й те саме |

---

## Section 3: Business Model and Google Contacts

**Describe your organization's work as it relates to YouTube** (мін. 100 символів):

> I am an individual creator running a small educational channel in Ukrainian
> called "Чи Ви Знали?" ("Did You Know?"). The channel publishes short vertical
> videos about Ukrainian geography, history, nature and science — for example,
> why the Vinnytsia fountain is sunk to the bottom of the river for the winter,
> or how a concert hall came to exist 288 metres underground in a Soledar salt
> mine. Each video is a narrated sequence of still images with burned-in
> subtitles, about 25 seconds long.
>
> I built a small private tool to automate the publishing step of my own
> workflow. The tool takes a finished video file that I have already produced
> and uploads it to my own channel on a schedule, together with the title,
> description and tags I wrote. It is used by me alone, through a private
> Telegram Mini App restricted to my own Telegram account, and it has no
> public interface, no sign-up and no other users.
>
> The tool touches only two YouTube Data API endpoints: videos.insert, to
> upload my own finished video to my own channel, and channels.list with
> mine=true, so that I can confirm which channel the authorised token belongs
> to before enabling uploads. It never searches YouTube, never reads channels
> or videos I do not own, never collects information about viewers, and never
> displays or embeds YouTube content anywhere.
>
> The imagery and narration in my videos are produced with generative models,
> so every upload sets status.containsSyntheticMedia to true and carries
> YouTube's altered-content disclosure. I apply the equivalent disclosure on
> every other platform I publish to.

| Поле | Значення |
|---|---|
| Target audience | General consumers |
| Monetization model | Free — the tool itself is not monetised and is not distributed |
| Do you sell advertisements or sponsorships ON or WITHIN YouTube content? | No |
| Prior written approval for commercial use | Not applicable |
| Designated Google Partner Manager | No |
| How did you discover the YouTube Data API | YouTube Data API official documentation |
| Content Owner IDs | None — not a CMS partner. Channel: `https://www.youtube.com/channel/UCTBLyrPdGVwcJ2HW2dpPcUg` |
| Google Ads Customer IDs | None |

---

## Section 4: API Client Overview and Access Information

| Поле | Значення |
|---|---|
| API Client Name | **Chy Vy Znaly Publisher** |
| Does the name contain "YouTube"? | No |
| Primary Access URL | `https://tiktok-chanel-production.up.railway.app/about` |
| Privacy Policy URL | `https://tiktok-chanel-production.up.railway.app/privacy` |
| Terms of Service URL | — (необов'язкове, лишити порожнім) |
| Is your API Client publicly accessible? | **No** |

**Пояснення до «not publicly accessible»** (де буде поле для коментаря або
демо-доступу):

> The client is a private, single-user tool. Its interface is a Telegram Mini
> App locked to one Telegram account: every request is verified against a
> Telegram HMAC signature and rejected unless it comes from the owner. I cannot
> issue demo credentials, because access is bound to a Telegram identity rather
> than to a username and password. I have attached screenshots of the interface,
> the OAuth consent flow and the upload result, and I am happy to record a
> screencast of a full upload on request.

---

## Section 5: Use Cases and Quota Details

| Поле | Значення |
|---|---|
| Google Cloud Project Number | `1064776695886` |
| Use case category | Video uploading · Internal tools |
| Does your client require OAuth 2.0? | Yes |
| Expected API Usage Volume | Up to 3 uploads per day (~90/month) |
| API endpoints used | `videos.insert`, `channels.list` |
| Quota requested per day | 10,000 units (current default is sufficient) |
| Peak per minute | 1 request |
| `videos.insert` per day | 3 (current default of 100 is sufficient) |
| `search.list` per day | 0 — not used |

**Justification** (обґрунтування квоти):

> I am not requesting an increase. My usage is three uploads per day, which is
> well within the default allocation. I am completing this audit so that my
> project can be verified as compliant with the YouTube API Services Terms of
> Service: uploads from unverified projects are locked to private visibility,
> which prevents me from publishing my own videos to my own channel
> automatically. The default quota is more than sufficient for my needs.

---

## Section 6: Additional Evidence

Знадобляться скриншоти. Зроби заздалегідь:

1. **Homepage** — `/about` у браузері, повна сторінка.
2. **Privacy policy** — `/privacy` у браузері, повна сторінка.
3. **OAuth consent flow** — екран згоди Google зі списком прав (той, що
   бачив на `/oauth/youtube/start`).
4. **Upload interface** — мінідодаток у Telegram: список готових роликів із
   назвою й описом.
5. **Result** — сторінка ролика в YouTube Studio, де видно, що завантажено
   через API і має позначку «altered or synthetic content».

Скриншоти інтерфейсу можна українською — головне, щоб було видно, що це за
екран; текстові відповіді мають бути англійською.

---

## Section 7: Attestations

Стандартні підтвердження згоди з YouTube API Services Terms of Service та
Developer Policies. Перед тим як ставити галочки, звір із тим, що ми справді
робимо:

- дані API не перепродаються і не передаються третім сторонам — ✅ правда;
- метрики YouTube не змішуються з даними інших платформ і не виводяться
  користувачам — ✅ правда, ми взагалі не читаємо метрик;
- контент не змінюється й не переупаковується — ✅ ми заливаємо власне відео;
- ШІ-контент декларується — ✅ `status.containsSyntheticMedia`.

---

## Після подання

Термін Google не називає — на практиці тижні. Відмова не остаточна, є форма
апеляції: https://support.google.com/youtube/contact/yt_api_appeals

Поки чекаєш — автопублікація може працювати: ролики лягатимуть на канал
приватними з готовими назвами, описами й позначками. Після схвалення в коді
міняти нічого не треба, той самий запит почне давати `public`.
