# Настройка «Наведи и убери»

Приложение статическое (PWA без сборки), но ему нужен свой Firebase-проект и
Cloudflare Worker для вызовов LLM с vision. Шаги, которые делает владелец аккаунта.

## 1. Firebase-проект

1. [Firebase Console](https://console.firebase.google.com/) → **Add project**.
2. **Authentication → Get started** → Sign-in method → включить **Email/Password**
   (и **Google**, если хотите вход родителя через Google).
3. **Authentication → Settings → Authorized domains** → добавить домен хостинга
   (напр. `natalyatsarapaeva-tech.github.io`) и `localhost`.
4. **Firestore Database → Create database** (ближайший регион).
5. **Storage → Get started** (для эталонных фото).
6. **Project settings → General → Your apps → Web (</>)** → скопировать
   `firebaseConfig` в [`js/firebase.js`](js/firebase.js) вместо `REPLACE_ME`.

## 2. Правила безопасности (ОБЯЗАТЕЛЬНО)

Без задеплоенных правил база в test mode — открыта всем.

- **Firestore:** Console → Firestore → **Rules** → вставить
  [`firestore.rules`](firestore.rules) → Publish.
- **Storage:** Console → Storage → **Rules** → вставить
  [`storage.rules`](storage.rules) → Publish.

Storage-правила читают Firestore (членство в семье) — деплой обоих обязателен.

## 3. Аккаунты и семья

- **Родитель** регистрируется в приложении сам (email/пароль). При первом входе
  авто-создаётся семья «Наш дом» с кодом присоединения.
- **Второй взрослый** (второй родитель, телефон бабушки) вводит **код семьи** —
  добавление идёт через Worker (`POST /tidy/join`), см. п.5.
- **Дети**: родитель со своего телефона создаёт детские аккаунты
  (служебные email вида `maya@tidy.local`, пароль генерируется) и на детском
  планшете один раз вызывает `provisionChildOnThisDevice(pin, email, password)` —
  дальше планшет логинится по PIN (аватар + 4 цифры). Экран настройки детей —
  часть родительской панели (доработать за этим каркасом).

## 4. Cloudflare Worker (LLM с vision)

Переиспользуем существующий воркер Twin и добавляем маршруты под префиксом
`/tidy/*` (§176 ТЗ). Референс форм запросов/ответов —
[`worker/tidy-routes.reference.js`](worker/tidy-routes.reference.js).

- `POST /tidy/parse-home` — текст дома → структура этажей/комнат.
- `POST /tidy/scan` — кадр → подсветка/маршрут.
- `POST /tidy/verify` — до/после → оценка.
- `POST /tidy/reward` — одна фраза персонажа.
- `POST /tidy/join` — присоединение по коду (Admin SDK пишет membership).
- `GET  /tidy/health` — остаток дневного бюджета.

Лимиты — по `X-Device-Id` (§174). Суточный бюджет общий; при превышении `429`,
клиент уходит в режим списка без камеры. Ключ LLM — секрет на стороне воркера.
Прописать `WORKER_URL` в [`js/ai.js`](js/ai.js) и `workerUrl` при вызове
`joinFamilyByCode`.

## 5. Иконки PWA

Положить `icons/icon-192.png` и `icons/icon-512.png`. Без них приложение
работает, но не устанавливается как PWA с иконкой.

## Проверка

1. `npm test` — чистое ядро зелёное (не требует Firebase).
2. `npm run serve` → открыть сайт (не `file://` — ES-модули). Вход родителя →
   должна создаться семья, показаться код и пустой список профилей.
