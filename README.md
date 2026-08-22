# Help_me_clean · «Наведи и убери»

Домашнее приложение, которое учит ребёнка убираться: ведёт по комнатам его
дома, показывает камерой, что именно надо убрать, и превращает это в короткие
выигрываемые раунды. Для детей и «kidults».

Приложение из семейства **Twin**: PWA без сборки (vanilla JS ES-модули), хостинг
на GitHub Pages, **отдельный** Firebase-проект (Auth + Firestore + Storage),
LLM с vision через Cloudflare Worker `/tidy/*`.

> **Статус: стартовый каркас.** Готов фундамент (авторизация, модель данных,
> правила, PWA-оболочка, чистое ядро с тестами). Экраны камеры/сканера/наград —
> дальше. План и обоснование — [`docs/AUTH-i-pereispolzovanie.md`](docs/AUTH-i-pereispolzovanie.md).
> Перед запуском — [`SETUP.md`](SETUP.md).

## Двухуровневая авторизация «пользователь → семья»

Как в Twin Things, по коду (перенос many-to-many модели):

- **Уровень 1 — пользователь.** Firebase Auth. Родитель — email/пароль; ребёнок —
  служебный аккаунт за аватаром + 4-значным PIN (`js/child-auth.js`, PIN
  расшифровывает пароль на устройстве через WebCrypto).
- **Уровень 2 — семья.** `families/{fid}` — контейнер (дом, профили, награды,
  эталоны). Членство: `families/{fid}/members/{uid}` — источник прав
  `{role: parent|child}`. Ребёнок заперт в свой профиль (`profileId == uid`) —
  правилом базы, а не только интерфейса.
- **Код** — для добавления **взрослых** устройств (второй родитель, второй
  телефон). Дети код не вводят. Join — через Worker `POST /tidy/join`.

## Структура

| Файл | Назначение |
|---|---|
| `index.html` | Вход (родитель email / ребёнок аватар+PIN), панель семьи, код, профили |
| `js/firebase.js` | Инициализация Firebase (Auth+Firestore+Storage, `browserLocalPersistence`) |
| `js/family-core.js` | **Чистое ядро:** роли, коды, id, активная семья, цветовой словарь действий, типы комнат, темы minion/jedi, награды, разбор ответов LLM |
| `js/child-auth.js` | Детский вход по PIN (WebCrypto: PIN → ключ → расшифровка пароля) |
| `js/store.js` | Авторизация + семьи (create/join/ensureFirst) + профили, прогресс, награды |
| `js/image.js` | Кадр для сканера (1024px, проверка яркости) + сжатие эталонов |
| `js/ai.js` | Вызовы Worker `/tidy/*` (parse-home, scan, verify, reward) |
| `firestore.rules` / `storage.rules` | Доступ по членству в семье + профиль-скоуп |
| `worker/tidy-routes.reference.js` | Референс маршрутов воркера (форма запросов, join на сервере) |
| `pwa.js` / `sw.js` / `manifest.json` | PWA: офлайн-оболочка, установка (альбомная ориентация) |
| `tests/family-core.test.mjs` | Тесты чистого ядра (`node --test`, без Firebase) — 13 тестов |

## Модель данных (Firestore)

```
users/{uid}                              — профиль {displayName, email, createdAt}
users/{uid}/families/{fid}               — индекс «мои семьи» {role, name, joinedAt}
families/{fid}                           — {name, ownerUid, joinCode, createdAt}
families/{fid}/members/{uid}             — ИСТОЧНИК ПРАВ {role: 'parent'|'child'}
families/{fid}/profiles/{pid}            — профиль ребёнка (pid == uid): theme, avatar, routeOrder
families/{fid}/profiles/{pid}/progress/{sessionId}
families/{fid}/profiles/{pid}/rewards/current
families/{fid}/reference/{surfaceId}     — эталонные фото
families/{fid}/cards/{cardId}            — коллекция
families/{fid}/home/*, /settings/*       — карта дома, плейлисты, бюджет
```

## Запуск

```bash
npm test       # node --test — чистое ядро (без Firebase)
npm run serve  # локальный сервер; file:// не работает (ES-модули)
```

## Дальше (по ТЗ)

Онбординг дома текстом → карта комнат → эталонные фото → режим камеры A
(подсветка по одному цвету) → проверка `/verify` → валюта/таймер/Apple Music.
Затем режим B (маршрут), коллекция, сюрпризы, родительская история.
