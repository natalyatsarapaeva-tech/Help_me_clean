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

## 4. Cloudflare Worker (LLM с vision) — путь B1: воркер как есть

Переиспользуем существующий воркер Twin `task-intake-worker` **без изменений**.
Его эндпоинт `/ai` — тонкий прокси OpenAI: принимает payload chat completions,
возвращает ответ OpenAI (ключ `OPENAI_API_KEY` — секрет на стороне воркера).
Промпты строятся на клиенте ([`js/ai.js`](js/ai.js)), разбор/санитайз ответов —
в чистом ядре. `WORKER_URL` уже вписан.

- Origin Pages нового приложения (`natalyatsarapaeva-tech.github.io`) — тот же,
  что у Twin, он уже в allow-list воркера. Ничего добавлять не нужно.
- AI-режимы работают сразу: `parseHome`, `scan` (closeup/overview), `verify`,
  `reward`.

**Альтернатива B2 (на будущее).** Если захочешь держать промпты и лимиты по
`X-Device-Id` (§174) на сервере — добавить в воркер маршруты `/tidy/*` по
референсу [`worker/tidy-routes.reference.js`](worker/tidy-routes.reference.js) и
переключить `js/ai.js` на них. Тот же файл нужен для `/tidy/join` (присоединение
второго взрослого по коду через Admin SDK) — это отдельная фича, для MVP не нужна.

## 5. Иконки PWA

Положить `icons/icon-192.png` и `icons/icon-512.png`. Без них приложение
работает, но не устанавливается как PWA с иконкой.

## Проверка

1. `npm test` — чистое ядро зелёное (не требует Firebase).
2. `npm run serve` → открыть сайт (не `file://` — ES-модули). Вход родителя →
   должна создаться семья, показаться код и пустой список профилей.
