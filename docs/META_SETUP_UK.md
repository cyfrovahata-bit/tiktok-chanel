# Одноразове підключення Facebook та Instagram

## Перед початком

- Instagram має бути **професійним** акаунтом (Business або Creator).
- Він має бути пов'язаний із потрібною Facebook Page.
- Facebook-користувач, який видає токен, повинен мати повний контроль над
  цією сторінкою.
- Пароль Facebook/Instagram і access token не можна надсилати в чат або
  комітити в GitHub.

## 1. Створити Meta App

1. Відкрити [Meta for Developers](https://developers.facebook.com/apps/).
2. Створити застосунок для керування контентом Facebook Page/Instagram.
3. Додати Instagram API with Facebook Login та можливість роботи зі
   сторінками Facebook.
4. Додати свій Facebook-профіль у ролі Administrator/Developer застосунку.

Для власних Page та Instagram застосунок можна спочатку лишити в Development
mode. App Review потрібен, коли доступ надаватимуть сторонні користувачі, які
не мають ролі в застосунку.

## 2. Видати дозволи

Для токена запросити:

- `pages_show_list`;
- `pages_read_engagement`;
- `pages_manage_posts`;
- `instagram_basic`;
- `instagram_content_publish`.

Зручно зробити це у [Graph API Explorer](https://developers.facebook.com/tools/explorer/),
вибравши щойно створений Meta App і свій Facebook-профіль.

## 3. Отримати Page ID, Instagram ID і Page token

З User access token виконати запит:

```text
GET /me/accounts?fields=id,name,access_token,instagram_business_account{id,username}
```

У відповіді потрібного об'єкта:

- `id` → `META_PAGE_ID`;
- `access_token` → `META_PAGE_ACCESS_TOKEN`;
- `instagram_business_account.id` → `META_IG_USER_ID`.

Якщо `instagram_business_account` відсутній, Instagram ще не пов'язаний із
цією Page або не переведений у professional account.

Для постійної роботи потрібен довготривалий токен. Короткий Explorer token
не підходить для щоденного автопостингу. Використайте long-lived User token,
після чого знову отримайте Page token через `/me/accounts`, або System User
token у Meta Business Settings.

## 4. Додати Railway Variables

У Railway → потрібний service → Variables додати:

```text
META_PAGE_ID=...
META_IG_USER_ID=...
META_PAGE_ACCESS_TOKEN=...
META_GRAPH_VERSION=v25.0
```

Спочатку лишити вимкненими або не створювати:

```text
ENABLE_FB
ENABLE_IG
```

Після редеплою відкрити `https://<railway-domain>/healthz`. Очікувано:

```json
{
  "meta": {
    "facebookConfigured": true,
    "instagramConfigured": true
  }
}
```

Після тестового виклику й перевірки токена додати:

```text
ENABLE_FB=1
ENABLE_IG=1
```

## 5. Як працює публікація

- Instagram: створення REELS media container → очікування `FINISHED` →
  `media_publish`.
- Facebook: `video_reels` start → передача публічного HTTPS URL → finish із
  `video_state=PUBLISHED`.
- Опис береться з колонки **«Опис для соцмереж»** без переписування.
- Після Meta API таблиця не змінюється.

Офіційні довідки:

- [Instagram Content Publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)
- [Facebook Reels Publishing API](https://developers.facebook.com/documentation/video-api/guides/reels-publishing)
- [Meta permissions](https://developers.facebook.com/docs/permissions/)
