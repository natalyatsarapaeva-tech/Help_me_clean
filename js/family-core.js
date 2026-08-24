// Чистое ядро «Наведи и убери» (без Firebase/DOM — тестируется в Node).
// Портировано из Twin Things js/catalog-core.js: коды присоединения, роли,
// идентификаторы, активный контейнер, разбор ответов LLM. Плюс доменные
// константы приложения: цветовой словарь действий, типы комнат, темы, награды.
//
// Двухуровневая модель «пользователь → семья» (many-to-many, как каталог в Twin):
//   users/{uid}/families/{fid}   — индекс «мои семьи» {role, name, joinedAt}
//   families/{fid}/members/{uid} — источник прав {role: 'parent'|'child', addedBy, joinedAt}
// Роли: parent (≈owner) | child (≈editor, но заперт в свой профиль profileId==uid).

// Человеческие тексты (подписи категорий, видов очагов, образов, рангов) живут
// не здесь, а в js/i18n.js: ядро знает только стабильные id, а как это звучит
// по-русски или по-английски — решает словарь. Поэтому все подписи ниже —
// функции, а не константы: язык переключается в родительской части на лету.
import { t, tList } from './i18n.js';
import {
  defaultThemes, normalizeThemes, resolveTheme, migrateLegacyThemeId,
} from './themes-core.js';

// ── Роли ────────────────────────────────────────────────────────────────────
export const ROLES = ['parent', 'child'];
export const PARENT = 'parent';
export const CHILD = 'child';

export function isValidRole(role) { return ROLES.includes(role); }
// Управлять семьёй (дом, награды, эталоны, участники, joinCode) — только родитель.
export function canManageFamily(role) { return role === PARENT; }
// Ребёнок работает только со своим профилем; родитель — со всем.
export function canAccessProfile(role, myProfileId, profileId) {
  return role === PARENT || (role === CHILD && profileId === myProfileId);
}

// ── Коды присоединения (перенос из Twin household/catalog-core) ──────────────
// 6 символов без визуально похожих (I/L/O/0/1). Код — для добавления ВЗРОСЛЫХ
// устройств в семью; дети код не вводят (их провиженит родитель).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeJoinCode(rand = Math.random) {
  return Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)]).join('');
}
export function normalizeJoinCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
export function isValidJoinCode(raw) {
  return normalizeJoinCode(raw).length === 6;
}

// ── Идентификаторы ──────────────────────────────────────────────────────────
export function makeFamilyId(name, rand = Math.random) {
  const slug = String(name || 'family').toLowerCase()
    .replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'family';
  return `${slug}-${Math.floor(rand() * 1e9).toString(36)}`;
}
export function makeSessionId(now = Date.now, rand = Math.random) {
  return `sess-${now()}-${Math.floor(rand() * 1e6).toString(36)}`;
}
export function makeSurfaceId(roomId, surfaceName, rand = Math.random) {
  const slug = String(surfaceName || 'surface').toLowerCase()
    .replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'surface';
  return `${roomId || 'room'}-${slug}-${Math.floor(rand() * 1e6).toString(36)}`;
}

// ── Активная семья (перенос pickActiveCatalog) ──────────────────────────────
// У ребёнка семья одна; у родителя может быть несколько (свой дом + второй дом).
export function pickActiveFamily(families, savedId) {
  if (!Array.isArray(families) || families.length === 0) return null;
  if (savedId && families.some(f => f.id === savedId)) return savedId;
  return families[0].id;
}

// ── Типы комнат (закрытый список, §210 ТЗ) ──────────────────────────────────
// К каждому типу подтягиваются заготовленные шаги и подсказки сканера.
export const ROOM_TYPES = ['kitchen', 'bedroom_child', 'bathroom', 'living', 'hall', 'utility', 'other'];
export function isValidRoomType(t) { return ROOM_TYPES.includes(t); }
export function normalizeRoomType(t) { return ROOM_TYPES.includes(t) ? t : 'other'; }

// ── Норма порядка: что вообще считается «убрано» ────────────────────────────
// Одно определение на всё приложение: по нему сканер ищет работу, по нему же
// проверка решает, стало ли чисто. Раньше требования были «лайтовые» — снять
// одежду со стула и всё; норма поднимает планку до нормально организованной
// комнаты, но остаётся посильной для ребёнка.
export function tidyStandard() { return tList('tidy.standard'); }
export function tidyStandardText() { return tidyStandard().map(x => `- ${x}`).join('\n'); }

// Планка проверки «после»: по ней решается, засчитана уборка или нет.
// Требования были размытые («убрано большинство»), и один и тот же стол
// засчитывался то так, то эдак. Теперь считаем: мусора на поверхности не
// остаётся ВООБЩЕ, прочих посторонних предметов — не больше трёх суммарно.
// Тройка — не придирка, а допуск: одна забытая кружка и книжка уборку не
// отменяют, а вот пять предметов — это уже неубранный стол.
export const VERIFY_LIMITS = { trash: 0, others: 3 };
export function verifyLimitsText() {
  return tList('verify.limits')
    .map(x => `- ${x.replace('{others}', String(VERIFY_LIMITS.others))}`).join('\n');
}

// ── Цветовой словарь действий (§232, фиксированный — модель НЕ выдумывает) ───
// Единственное, что тема НЕ перекрашивает (§371). category — из закрытого списка.
// Здесь — только то, что от языка не зависит: id, цвет и эмодзи. Инструкция и
// «куда нести» приходят из словаря по ключам action.<id>.instruction/.target.
export const ACTION_CATEGORIES = [
  { id: 'paper',             color: '#2F6BFF', emoji: '🔵' },
  { id: 'stationery',        color: '#25A55A', emoji: '🟢' },
  { id: 'trash',             color: '#8B5CF6', emoji: '🟣' },
  { id: 'dishes',            color: '#F0871E', emoji: '🟠' },
  { id: 'textile',           color: '#F5C518', emoji: '🟡' },
  { id: 'toys',              color: '#F472B6', emoji: '🩷' },
  // Пол — отдельная категория, а не «мусор»: коробка или удлинитель нужны,
  // просто им не место на полу.
  { id: 'floor',             color: '#8D6E63', emoji: '🟤' },
  // Заправить кровать — не «отнести вещь», а привести в порядок то, что уже
  // стоит на своём месте. Шаг всё равно один: сделал — отметил.
  { id: 'make_bed',          color: '#00ACC1', emoji: '🛏' },
  { id: 'belongs_elsewhere', color: '#9AA3AE', emoji: '⚪️' },
  // Всегда последний шаг раунда (см. LAST_CATEGORIES в round-core): выносить
  // урну имеет смысл, когда весь мусор комнаты уже в неё сложен.
  { id: 'bin_full',          color: '#E53935', emoji: '🗑' },
];
export const ACTION_IDS = ACTION_CATEGORIES.map(c => c.id);
const ACTION_BY_ID = new Map(ACTION_CATEGORIES.map(c => [c.id, c]));
// Локализованная категория: цвет и эмодзи из списка выше, тексты — из словаря.
// Собирается на каждый вызов, потому что язык можно переключить, не перезагружая
// экран (index.html перерисовывает себя целиком).
function localizeAction(base) {
  return base && {
    ...base,
    instruction: t(`action.${base.id}.instruction`),
    target: t(`action.${base.id}.target`),
  };
}
export function actionCategories() { return ACTION_CATEGORIES.map(localizeAction); }

// Старые id, которые ещё могут прийти из сохранённого прогресса или от модели.
// clothes → textile: «одежда» заставляла и модель, и ребёнка спотыкаться на
// полотенцах, тряпках и постельном белье — а это ровно то, что валяется чаще
// всего. Конкретное название вещи никуда не делось: оно в label предмета
// («джинсы», «полотенце»), категория же говорит, ЧТО С ЭТИМ ДЕЛАТЬ.
export const CATEGORY_ALIASES = { clothes: 'textile' };
export function normalizeActionCategory(id) {
  const key = String(id || '');
  return CATEGORY_ALIASES[key] || key;
}
export function actionCategory(id) { return localizeAction(ACTION_BY_ID.get(normalizeActionCategory(id))) || null; }
export function isValidActionCategory(id) { return ACTION_BY_ID.has(normalizeActionCategory(id)); }

// ── Контекст кадра: за что вообще можно предложить бонус ────────────────────
// Бонусные задания раньше выбирались по типу комнаты: в детской могло выпасть
// «полей цветок» там, где цветка нет, и «протри стол тряпочкой» после уборки
// пола. Задание, не связанное с тем, что ребёнок только что делал, читается
// как случайная придирка и обесценивает саму идею бонуса.
//
// Поэтому у бонуса теперь два вида требований:
//   seen    — что ВИДНО в кадре. Называет сканер тем же вызовом, что ищет работу
//             (лишний вызов ИИ на это тратить незачем).
//   cleaned — что ребёнок ТОЛЬКО ЧТО убрал. Выводим сами из закрытых шагов
//             раунда (round-core.roundContextTags) — модели тут верить не в чем.
export const SEEN_TAGS = ['plant', 'mirror', 'shoes', 'books'];
export function seenTagsText() { return SEEN_TAGS.map(tag => `  ${t(`seen.${tag}`)}`).join('\n'); }
export const CLEANED_TAGS = ['surface', 'floor', 'textile', 'bed', 'trash', 'wiped'];
export function normalizeTags(list, allowed) {
  const ok = new Set(allowed);
  return [...new Set((Array.isArray(list) ? list : []).map(String).filter(t => ok.has(t)))];
}

// ── Очаги беспорядка: зоны комнаты (режим «фото комнаты», §268) ─────────────
// В обходе комнаты шаг — не отдельная вещь, а ОЧАГ: стул с одеждой, пол,
// стол, полка, урна. Так и рассуждает человек, который заходит в комнату:
// «одежду со стула, потом пол, потом разберу стол» — а не «синий грузовик,
// потом мишка, потом носки». Пунктирная россыпь из пятнадцати точек по одной
// вещи не даёт ребёнку увидеть фронт работ и утомляет раньше, чем комната
// становится чище.
//
// closeup: true — очаг, который с порога комнаты ВИДНО, но не РАЗГЛЯДЕТЬ: на
// столе лежит «что-то мелкое». Такой шаг просит подойти и снять крупным
// планом — дальше работает режим A со своими рамками и цветами.
// color/instruction/target — запасные: у очага обычно есть категория действия
// со своим цветом и текстом. Своих не хватает только «протереть» — категории
// для него в словаре нет и быть не должно (сканер такое не размечает).
// Как и у категорий, здесь только неязыковое: id, эмодзи, цвет и то, просит ли
// очаг крупный план. Название и строка плана — по ключам zone.<id>.name/.plan.
export const ZONE_KINDS = [
  { id: 'chair',   emoji: '🪑', closeup: false, color: '#F5C518' },
  { id: 'floor',   emoji: '🟤', closeup: false, color: '#8D6E63' },
  { id: 'bed',     emoji: '🛏', closeup: false, color: '#00ACC1' },
  { id: 'desk',    emoji: '📝', closeup: true,  color: '#2F6BFF' },
  { id: 'shelf',   emoji: '📚', closeup: true,  color: '#25A55A' },
  { id: 'surface', emoji: '🪟', closeup: true,  color: '#F0871E' },
  // Протирание не приходит от модели: пыли на фото не видно. Этот шаг добавляем
  // сами — к поверхности, которую ребёнок только что освободил (см. round-core).
  // Своих instruction/target нет ни у кого, кроме него: у остальных очагов есть
  // категория действия со своим текстом.
  { id: 'wipe',    emoji: '🧽', closeup: false, color: '#00BFA5', hasOwnText: true },
  { id: 'bin',     emoji: '🗑', closeup: false, color: '#E53935' },
  { id: 'other',   emoji: '✨', closeup: false, color: '#9AA3AE' },
];
export const ZONE_IDS = ZONE_KINDS.map(z => z.id);
const ZONE_BY_ID = new Map(ZONE_KINDS.map(z => [z.id, z]));
function localizeZone(base) {
  if (!base) return base;
  const out = { ...base, name: t(`zone.${base.id}.name`), plan: t(`zone.${base.id}.plan`) };
  if (base.hasOwnText) {
    out.instruction = t(`zone.${base.id}.instruction`);
    out.target = t(`zone.${base.id}.target`);
  }
  return out;
}
export function zoneKinds() { return ZONE_KINDS.map(localizeZone); }
export function normalizeZoneKind(id) { return ZONE_BY_ID.has(String(id)) ? String(id) : 'other'; }
export function zoneKind(id) { return localizeZone(ZONE_BY_ID.get(normalizeZoneKind(id))); }
// Очаг из нескольких мелочей просит крупный план; одна коробка на полу — нет.
// Слово модели весомее умолчания: она видит кадр, а мы — только вид очага.
export function zoneNeedsCloseup(kind, itemsEstimate, said) {
  if (said === true || said === false) return said;
  return zoneKind(kind).closeup && (Number(itemsEstimate) || 0) >= 3;
}

// ── Темы (§43 ТЗ) — их придумывает СЕМЬЯ, а не мы ────────────────────────────
// Раньше здесь лежал зашитый объект THEMES с двумя франшизными образами.
// Теперь темы — данные семьи (families/{fid}/settings/app → themes), и правит
// их родитель на themes.html: имя, палитра, названия рангов, карточки.
// Форма, палитра и правила — в js/themes-core.js; здесь только РЕЕСТР: какие
// темы сейчас у семьи и как по id получить готовую к отрисовке тему.
//
// Реестр модульный, а не параметр каждой функции, ровно потому, что тему
// спрашивает почти каждый экран (`theme(id).currencyEmoji` в счётчике искорок,
// в магазине, в коллекции). Экран ставит темы семьи один раз после загрузки
// настроек — applyFamilyThemes(settings) в js/store.js, — дальше всё работает
// как раньше. Пока настройки не загружены, в реестре пресеты: приложение
// рисуется, а не падает.
let FAMILY_THEMES = defaultThemes();
export function setFamilyThemes(list) { FAMILY_THEMES = normalizeThemes(list); return FAMILY_THEMES; }
// Документы тем как есть — для экрана родителя (там их правят, а не рисуют).
export function familyThemes() { return FAMILY_THEMES.map(th => ({ ...th, colors: { ...th.colors }, ranks: [...th.ranks] })); }
export function themeIds() { return FAMILY_THEMES.map(th => th.id); }
// ВАЖНО: у профиля НЕТ темы по умолчанию. Тема — выбор самого ребёнка на входе
// («Кто ты сегодня?»), а не настройка, которую задаёт родитель. Первая тема
// семьи — только фолбэк отрисовки, пока выбор не сделан.
export function fallbackThemeId() { return FAMILY_THEMES[0].id; }
export function theme(id) {
  const key = migrateLegacyThemeId(id);
  return resolveTheme(FAMILY_THEMES.find(th => th.id === key) || FAMILY_THEMES[0]);
}
export function isValidTheme(id) { return FAMILY_THEMES.some(th => th.id === migrateLegacyThemeId(id)); }
export function normalizeTheme(id) {
  const key = migrateLegacyThemeId(id);
  return isValidTheme(key) ? key : null;
}

// Ранги (§37) — прогресс только растёт.
// Пороги — здесь (они про механику), названия — у темы: «Яйцо → Тираннозавр»
// придумывает родитель под интересы ребёнка, а не мы под чужую франшизу.
export const RANK_THRESHOLDS = [0, 8, 25, 60];
export function rankNames(themeId) { return theme(themeId).ranks; }
export function rankIndexForCleanups(n) {
  const c = Number(n) || 0;
  let i = 0;
  while (i + 1 < RANK_THRESHOLDS.length && c >= RANK_THRESHOLDS[i + 1]) i += 1;
  return i;
}
export function rankForCleanups(n, themeId) { return rankNames(themeId)[rankIndexForCleanups(n)]; }

// ── Проверка по фото: обязательна или нет (настройка семьи) ─────────────────
// Умолчание — обязательна: проверка «после» и есть то, ради чего снимают фото,
// и именно она держит счётчик уборок честным. Но семьям с малышом, у которого
// «убрано» и «убрано по эталону» — разные вселенные, нужен выход: с выключенной
// настройкой ребёнок видит разбор кадра и может закрыть уборку сам.
// Переключатель — в разделе эталонов (reference.html): там же объяснено, с чем
// сравнивается «после».
export function photoCheckRequired(settings) { return settings?.photoCheckRequired !== false; }
// Можно ли закрыть раунд, который проверка не засчитала.
export function canFinishUnverified(settings) { return !photoCheckRequired(settings); }

// ── Награды (§317). Валюта начисляется только за ЗАКРЫТЫЕ шаги. ──────────────
// ДВА числа, а не одно:
//   currency    — БАЛАНС: сколько можно потратить на реальную награду сейчас;
//   earnedTotal — сколько заработано ЗА ВСЁ ВРЕМЯ: не убывает никогда.
// Разделены ради покупок: тратить надо, а обнулять достигнутое нельзя (§336).
// Ранг и «сколько ты уже наработал» считаются от earnedTotal и cleanupsTotal —
// покупка мороженого не понижает ребёнка из третьего ранга обратно во второй.
export const SPARKLES = { step: 1, room: 5, day: 15 };
export function sparklesFor(kind) { return SPARKLES[kind] || 0; }

// Что принадлежит РЕБЁНКУ, а что ТЕМЕ:
//   валюта, счётчик уборок, реальные награды — общие: ребёнок один, тему он
//   меняет как настроение, и прогресс за это не должен теряться (§49);
//   коллекция карточек — своя у каждой темы: у «динозавров» свои карточки, у
//   «космоса» свои. Смена темы показывает другую витрину, ничего не отнимая.
export function emptyRewards() {
  return {
    currency: 0,      // баланс: тратится покупками
    earnedTotal: 0,   // заработано за всё время: только растёт
    cleanupsTotal: 0,
    cardsByTheme: Object.fromEntries(themeIds().map(t => [t, []])),
    realRewards: [],   // покупки реальных наград, см. js/shop-core.js
    dailyRooms: { day: null, rooms: {}, places: {} }, // дневной лимит, см. js/limits-core.js
    dailyBonus: { day: null, ids: {}, total: 0 },      // бонусные задания, см. js/bonus-core.js
    lastSurpriseAt: null,
  };
}
// Счётчик «сколько раз сегодня убирали каждую комнату». Форма живёт здесь,
// потому что normalizeRewards — единственное место, где документ наград
// приводится к предсказуемому виду; смысл и правила — в js/limits-core.js.
function normalizeDailyRooms(raw) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  const counters = (src) => {
    const out = {};
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
      }
    }
    return out;
  };
  return {
    day: typeof d.day === 'string' ? d.day : null,
    rooms: counters(d.rooms),   // страховочный счётчик по комнате
    places: counters(d.places), // основной: по конкретному месту
  };
}
// Приводит документ наград к актуальной форме. Мигрирует старый плоский
// cards: [id] — карточки без темы уезжают в коллекцию фолбэк-темы.
export function normalizeRewards(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const base = emptyRewards();
  const byTheme = { ...base.cardsByTheme };
  // Читаем ВСЕ коллекции документа, а не только темы, которые есть у семьи
  // сейчас: родитель мог удалить тему или переименовать franchise-id прошлой
  // версии — добытое при этом не пропадает (§336), просто не показывается.
  for (const [rawId, list] of Object.entries(r.cardsByTheme || {})) {
    if (!Array.isArray(list)) continue;
    const id = migrateLegacyThemeId(rawId);
    byTheme[id] = Array.from(new Set([...(byTheme[id] || []), ...list]));
  }
  if (Array.isArray(r.cards) && r.cards.length) {
    const legacy = byTheme[fallbackThemeId()] || [];
    byTheme[fallbackThemeId()] = Array.from(new Set([...legacy, ...r.cards]));
  }
  const currency = Number(r.currency) || 0;
  return {
    currency,
    // Миграция старых документов: до появления покупок числа совпадали.
    earnedTotal: Math.max(Number(r.earnedTotal) || 0, currency),
    cleanupsTotal: Number(r.cleanupsTotal) || 0,
    cardsByTheme: byTheme,
    realRewards: Array.isArray(r.realRewards) ? r.realRewards : [],
    dailyRooms: normalizeDailyRooms(r.dailyRooms),
    dailyBonus: normalizeDailyBonus(r.dailyBonus),
    lastSurpriseAt: r.lastSurpriseAt || null,
  };
}
// Коллекция конкретной темы (витрина, куда ребёнок возвращается).
export function cardsForTheme(rewards, themeId) {
  return normalizeRewards(rewards).cardsByTheme[normalizeTheme(themeId) || fallbackThemeId()] || [];
}
// Чистое добавление карточки в коллекцию темы (без дублей). Вход не мутирует.
export function addCard(rewards, themeId, cardId) {
  const out = normalizeRewards(rewards);
  const t = normalizeTheme(themeId) || fallbackThemeId();
  const owned = out.cardsByTheme[t] || [];
  if (cardId && !owned.includes(cardId)) out.cardsByTheme[t] = [...owned, cardId];
  return out;
}
// Начисление валюты — всегда на ребёнка, независимо от выбранной темы.
// Штрафов и обнулений нет (§336). Растут оба числа: баланс — чтобы было что
// потратить, earnedTotal — чтобы достигнутое не зависело от трат.
export function addSparkles(rewards, kind) {
  const out = normalizeRewards(rewards);
  const amount = sparklesFor(kind);
  out.currency += amount;
  out.earnedTotal += amount;
  if (kind === 'day') out.cleanupsTotal += 1;
  return out;
}

// Переменное подкрепление (§330): сюрприз в среднем раз в 4 шага, разброс 2–7.
// Чистая функция — источник случайности подаётся извне (детерминизм в тестах).
export function nextSurpriseIn(rand = Math.random, min = 2, max = 7) {
  return min + Math.floor(rand() * (max - min + 1));
}
export function shouldSurprise(stepsSinceLast, threshold) {
  return Number(stepsSinceLast) >= Number(threshold);
}

// ── Разбор ответов LLM (перенос из Twin, §442: только JSON + повтор + санитайз)
export function stripJsonFences(text) {
  return String(text || '').trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
}
export function parseJsonObject(content) {
  const cleaned = stripJsonFences(content);
  try { const v = JSON.parse(cleaned); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch (_) {}
  const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
  if (s !== -1 && e > s) { try { const v = JSON.parse(cleaned.slice(s, e + 1)); if (v && typeof v === 'object') return v; } catch (_) {} }
  return {};
}
export function parseJsonArray(content) {
  const cleaned = stripJsonFences(content);
  try { const v = JSON.parse(cleaned); if (Array.isArray(v)) return v; } catch (_) {}
  const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
  if (s !== -1 && e > s) { try { const v = JSON.parse(cleaned.slice(s, e + 1)); if (Array.isArray(v)) return v; } catch (_) {} }
  return [];
}

// Нормализованный box [x1,y1,x2,y2] (углы) → [x,y,w,h] 0..1 (перенос из Twin).
export function cornersToXywh(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const n = box.map(Number);
  if (!n.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = n;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)];
}

// Точка очага на кадре: [x,y] в долях 0..1. Кривые числа не выбрасывают очаг —
// метка просто встаёт в центр кадра: потерять реальную работу хуже, чем
// нарисовать кружок не там, где надо (ребёнок и так смотрит на свою комнату).
export function clampPoint(raw) {
  const p = Array.isArray(raw) ? raw.map(Number) : [];
  const at = i => (Number.isFinite(p[i]) ? Math.min(1, Math.max(0, p[i])) : 0.5);
  return [at(0), at(1)];
}

// Санитайзинг ответа /scan (§246/§276): отбрасываем неизвестные категории и
// кривые координаты, чтобы клиент рисовал только валидные подсветки.
export function sanitizeScan(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const mode = r.mode === 'overview' ? 'overview' : 'closeup';
  if (mode === 'overview') {
    // Модель отвечает очагами (zones). Старый формат «маршрут по точкам»
    // (route) продолжаем принимать: модель иногда сваливается в него, и терять
    // из-за этого весь скан нельзя — каждая точка становится очагом «ещё».
    const raw = Array.isArray(r.zones) ? r.zones
      : (Array.isArray(r.route) ? r.route.map(s => ({ ...s, kind: 'other', needs_closeup: false })) : []);
    const zones = raw
      .filter(z => z && isValidActionCategory(z.category))
      .map((z, i) => {
        const kind = normalizeZoneKind(z.kind);
        const itemsEstimate = Math.max(0, Math.round(Number(z.items_estimate) || 0));
        return {
          id: Number.isInteger(z.id) ? z.id : (Number.isInteger(z.step) ? z.step : i + 1),
          kind,
          label: String(z.label || '').trim() || zoneKind(kind).name,
          point: clampPoint(z.point),
          category: normalizeActionCategory(z.category),
          action: String(z.action || '').trim(),
          itemsEstimate,
          needsCloseup: zoneNeedsCloseup(kind, itemsEstimate, z.needs_closeup),
        };
      });
    return {
      mode, zones,
      place: cleanPlace(r.place),
      estimated_minutes: Number(r.estimated_minutes) || null,
      // Что ещё есть в кадре — для контекстных бонусов, см. SEEN_TAGS.
      seen: normalizeTags(r.seen, SEEN_TAGS),
    };
  }
  const items = (Array.isArray(r.items) ? r.items : [])
    .filter(it => it && isValidActionCategory(it.category))
    .map((it, i) => {
      const box = Array.isArray(it.box) ? cornersToXywh(it.box)
        : (Array.isArray(it.bbox) && it.bbox.length === 4 ? it.bbox.map(Number) : null);
      return {
        id: Number.isInteger(it.id) ? it.id : i + 1,
        label: String(it.label || '').trim(),
        category: normalizeActionCategory(it.category),
        box,
        confidence: Number(it.confidence) || null,
      };
    })
    .filter(it => it.box);
  // Группы-счётчики (§244): «работа по одному цвету за раз».
  const groups = ACTION_IDS
    .map(cat => ({ category: cat, count: items.filter(it => it.category === cat).length }))
    .filter(g => g.count > 0)
    .map(g => ({ ...g, instruction: actionCategory(g.category).instruction }));
  return {
    mode, items, groups, place: cleanPlace(r.place),
    surface_state: r.surface_state === 'clean' ? 'clean' : 'messy',
    seen: normalizeTags(r.seen, SEEN_TAGS),
  };
}

// «Место» в кадре — что именно сняли: раковина, стол у окна, пол у двери.
// Нужно, чтобы дневной лимит считался ПО МЕСТУ, а не по всей комнате: у комнаты
// много углов, и запрещать её целиком после двух уборок неправильно.
// Приводим к сравнимому виду: регистр, пробелы, кавычки и точки — не различия.
export function cleanPlace(raw) {
  return String(raw || '').toLowerCase()
    .replace(/[«»"'`.,;:!?()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

// Счётчик бонусных заданий за сегодня (js/bonus-core.js): какие сделаны и сколько.
function normalizeDailyBonus(raw) {
  const b = (raw && typeof raw === 'object') ? raw : {};
  const ids = {};
  if (b.ids && typeof b.ids === 'object') {
    for (const [k, v] of Object.entries(b.ids)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) ids[k] = Math.floor(n);
    }
  }
  return {
    day: typeof b.day === 'string' ? b.day : null,
    ids,
    total: Math.max(0, Math.floor(Number(b.total) || 0)),
  };
}

// Санитайзинг ответа проверки БОНУСА. Тут, в отличие от /verify, человек в кадре
// — это норма: ребёнок именно и показывает, что он делает. Поэтому person_detected
// не проверяем, а спрашиваем только «видно ли то, о чём просили».
export function sanitizeBonus(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const done = r.done === true;
  return {
    done,
    praise: String(r.praise || '').trim(),
    // Подсказка нужна только когда не засчитали: что именно доснять.
    hint: done ? '' : String(r.hint || '').trim(),
  };
}

// Санитайзинг ответа /verify (§292): мягкая оценка, статусы done/retake.
export const VERIFY_SCORES = ['great', 'good', 'ok'];
export function sanitizeVerify(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  if (r.person_detected === true) return { ...EMPTY_VERIFY, status: 'person' };
  if (r.retake === true || r.status === 'retake') return { ...EMPTY_VERIFY, status: 'retake' };
  // Что осталось на поверхности — списком с количеством. Раньше просили ОДНУ
  // вещь (§296), но «осталось: носок» на заваленном столе звучало как придирка
  // и не показывало ребёнку, сколько ещё работы.
  const left = (Array.isArray(r.left) ? r.left : []).slice(0, 4).map(x => ({
    label: String(x?.label || '').trim(),
    count: Math.max(1, Math.round(Number(x?.count) || 1)),
    category: isValidActionCategory(x?.category) ? normalizeActionCategory(x.category) : null,
    // Готовая фраза от модели: падежи, числительные и артикли она согласует
    // лучше любого нашего шаблона («выбросить три бумажки» / «throw out three
    // scraps of paper»). Язык фразы задаёт промпт (js/ai.js).
    todo: String(x?.todo || '').trim(),
  })).filter(x => x.label || x.todo);
  // Рамки вокруг того, что осталось: экран покажет их прямо на «финальном»
  // фото. Словами «убери лишнее» ребёнок не понимает, ЧТО именно лишнее.
  const boxes = (Array.isArray(r.boxes) ? r.boxes : []).slice(0, 12)
    .map(b => ({ label: String(b?.label || '').trim(), box: cornersToXywh(b?.box) }))
    .filter(b => b.box);
  const beforeCount = countOrNull(r.before_count);
  const afterCount = countOrNull(r.after_count) ?? (boxes.length || null);
  const referenceCount = countOrNull(r.reference_count);

  const isTrash = (x) => x.category === 'trash' || x.category === 'bin_full';
  const trashLeft = left.filter(isTrash).reduce((n, x) => n + x.count, 0);
  const listOthers = left.filter(x => !isTrash(x)).reduce((n, x) => n + x.count, 0);
  // Список и общий счёт могут расходиться: модель называет три группы, а всего
  // видит девять предметов. Берём СТРОГОЕ прочтение — иначе проверку обходит
  // сама неаккуратность ответа.
  const othersLeft = afterCount == null ? listOthers : Math.max(listOthers, afterCount - trashLeft);

  // Судить не по чему: ни списка, ни счёта. Это не «убрано» — это нечитаемый
  // ответ, и раньше он молча засчитывался как успех (у модели просили список,
  // она возвращала пустой — и уборка «проходила» с тем же беспорядком в кадре).
  const unverified = !left.length && afterCount == null;
  // Эталон родителя строже нашей тройки: если на «после» лишнего больше, чем
  // на фото «как должно быть» — не убрано, сколько бы там ни было предметов.
  const overReference = referenceCount != null && afterCount != null && afterCount > referenceCount;
  const done = !unverified
    && trashLeft <= VERIFY_LIMITS.trash
    && othersLeft <= VERIFY_LIMITS.others
    && !overReference;
  return {
    done,
    status: unverified ? 'unclear' : (done ? 'done' : 'incomplete'),
    score: VERIFY_SCORES.includes(r.score) ? r.score : 'ok',
    praise: String(r.praise || '').trim(),
    left, boxes,
    trashLeft, othersLeft: Math.max(0, othersLeft),
    beforeCount, afterCount, referenceCount, overReference, unverified,
    // Стало ли лучше вообще. false — кадр «после» не отличается от «до»:
    // сфотографировали тот же беспорядок дважды.
    improved: (beforeCount != null && afterCount != null) ? afterCount < beforeCount : null,
    // Совместимость с прежним полем: что именно осталось сделать.
    missed: left.map(x => x.todo || x.label).filter(Boolean),
  };
}
const EMPTY_VERIFY = {
  done: false, status: 'incomplete', score: 'ok', praise: '',
  left: [], boxes: [], trashLeft: 0, othersLeft: 0,
  beforeCount: null, afterCount: null, referenceCount: null,
  overReference: false, unverified: false, improved: null, missed: [],
};
function countOrNull(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// «Осталось только выбросить три бумажки и отнести посуду на место».
// Мягко по форме, конкретно по содержанию: ребёнок должен понимать, сколько
// именно осталось, иначе «почти получилось» звучит как отказ без объяснения.
export function missedPhrase(left, limit = 3) {
  const parts = (Array.isArray(left) ? left : [])
    .map(x => (typeof x === 'string' ? x : (x?.todo || (x?.label ? t('missed.putAway', { label: x.label }) : ''))))
    .filter(Boolean).slice(0, limit);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} ${t('missed.and')} ${parts[parts.length - 1]}`;
}

// Санитайзинг ответа /parse-home (§188): этажи → комнаты с валидным типом.
export function sanitizeHome(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const floors = (Array.isArray(r.floors) ? r.floors : []).map(fl => ({
    name: String(fl?.name || '').trim(),
    rooms: (Array.isArray(fl?.rooms) ? fl.rooms : []).map(rm => ({
      id: String(rm?.id || makeSurfaceId('room', rm?.name || '')).trim(),
      name: String(rm?.name || '').trim(),
      type: normalizeRoomType(rm?.type),
      icon: String(rm?.icon || '🏠'),
      surfaces: Array.isArray(rm?.surfaces) ? rm.surfaces.map(String) : [],
      typical_clutter: Array.isArray(rm?.typical_clutter) ? rm.typical_clutter.map(String) : [],
      needs_confirmation: rm?.needs_confirmation === true,
    })).filter(rm => rm.name),
  })).filter(fl => fl.rooms.length);
  return { floors };
}

// ── Карта дома: подписи типов, порядок обхода, reorder (для онбординга) ──────
export function roomTypeLabels() {
  return Object.fromEntries(ROOM_TYPES.map(id => [id, t(`roomType.${id}`)]));
}
export function roomTypeLabel(type) { return t(`roomType.${normalizeRoomType(type)}`); }

// Плоский список комнат в порядке этажей (каждой добавляется имя этажа).
export function roomsInOrder(home) {
  const floors = Array.isArray(home?.floors) ? home.floors : [];
  const out = [];
  for (const fl of floors) for (const rm of (fl.rooms || [])) out.push({ ...rm, floor: fl.name });
  return out;
}
// Порядок обхода по умолчанию (§215): сверху вниз по этажам, домашняя — первой.
export function defaultRouteOrder(home, homeRoomId) {
  const ids = roomsInOrder(home).map(r => r.id);
  if (homeRoomId && ids.includes(homeRoomId)) return [homeRoomId, ...ids.filter(id => id !== homeRoomId)];
  return ids;
}
// Чистый reorder (стрелки/drag). Возвращает новый массив, вход не мутирует.
export function moveInArray(arr, from, to) {
  const a = Array.isArray(arr) ? arr.slice() : [];
  if (from < 0 || from >= a.length || to < 0 || to >= a.length) return a;
  const [x] = a.splice(from, 1); a.splice(to, 0, x); return a;
}
// Синхронизировать сохранённый порядок с актуальными комнатами: убрать
// исчезнувшие id, дописать появившиеся в конец (комнаты правились в онбординге).
export function reconcileRouteOrder(savedOrder, home) {
  const ids = roomsInOrder(home).map(r => r.id);
  const kept = (Array.isArray(savedOrder) ? savedOrder : []).filter(id => ids.includes(id));
  const added = ids.filter(id => !kept.includes(id));
  return [...kept, ...added];
}

// ── Эталонные фото: покрытие комнат (§300) ──────────────────────────────────
// Эталон — снятая родителем «как должно выглядеть убранным» фотография поверхности.
// Проверка сравнивает «после» с НЕЙ, а не с идеалом из головы модели: у каждой
// семьи свой порядок, и «убрано» на кухне бабушки и в детской — разные вещи.
// Чистая свёртка «комнаты маршрута × эталоны» для экрана родителя.
export function referenceCoverage(rooms, references) {
  const byId = new Map((Array.isArray(references) ? references : [])
    .map(r => [r.id || r.surfaceId, r]).filter(([id]) => id));
  const list = (Array.isArray(rooms) ? rooms : []).map(r => ({ ...r, reference: byId.get(r.id) || null }));
  const covered = list.filter(r => r.reference).length;
  return { rooms: list, covered, total: list.length, complete: list.length > 0 && covered === list.length };
}
