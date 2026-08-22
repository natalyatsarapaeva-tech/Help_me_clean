// Чистое ядро «Наведи и убери» (без Firebase/DOM — тестируется в Node).
// Портировано из Twin Things js/catalog-core.js: коды присоединения, роли,
// идентификаторы, активный контейнер, разбор ответов LLM. Плюс доменные
// константы приложения: цветовой словарь действий, типы комнат, темы, награды.
//
// Двухуровневая модель «пользователь → семья» (many-to-many, как каталог в Twin):
//   users/{uid}/families/{fid}   — индекс «мои семьи» {role, name, joinedAt}
//   families/{fid}/members/{uid} — источник прав {role: 'parent'|'child', addedBy, joinedAt}
// Роли: parent (≈owner) | child (≈editor, но заперт в свой профиль profileId==uid).

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

// ── Цветовой словарь действий (§232, фиксированный — модель НЕ выдумывает) ───
// Единственное, что тема НЕ перекрашивает (§371). category — из закрытого списка.
export const ACTION_CATEGORIES = [
  { id: 'paper',            color: '#2F6BFF', emoji: '🔵', instruction: 'Собери все бумаги в одну стопку', target: 'На край стола' },
  { id: 'stationery',       color: '#25A55A', emoji: '🟢', instruction: 'Поставь карандаши и ручки в стакан', target: 'Стакан' },
  { id: 'trash',            color: '#8B5CF6', emoji: '🟣', instruction: 'Выброси мусор', target: 'Ведро' },
  { id: 'dishes',           color: '#F0871E', emoji: '🟠', instruction: 'Отнеси посуду', target: 'Кухня' },
  { id: 'textile',          color: '#F5C518', emoji: '🟡', instruction: 'Текстиль: грязное в корзину, чистое на место', target: 'Корзина или полка' },
  { id: 'toys',             color: '#F472B6', emoji: '🩷', instruction: 'Игрушки в свой ящик', target: 'Ящик' },
  { id: 'belongs_elsewhere',color: '#9AA3AE', emoji: '⚪️', instruction: 'Это живёт в другой комнате', target: 'Корзина «чужое»' },
];
export const ACTION_IDS = ACTION_CATEGORIES.map(c => c.id);
const ACTION_BY_ID = new Map(ACTION_CATEGORIES.map(c => [c.id, c]));

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
export function actionCategory(id) { return ACTION_BY_ID.get(normalizeActionCategory(id)) || null; }
export function isValidActionCategory(id) { return ACTION_BY_ID.has(normalizeActionCategory(id)); }

// ── Темы (§43 ТЗ). Механика одна, различаются палитра/тексты/шаг/озвучка ────
// Вынесены отдельно, чтобы подменить франшизные отсылки за час (§51).
export const THEMES = {
  minion: {
    id: 'minion', label: 'Миньон',
    currencyName: 'бананы', currencyEmoji: '🍌',
    voice: 'loud', stepGranularity: 'fine', tts: true,
    colors: { primary: '#FFD836', secondary: '#3A5DA8', bg: '#FFFFFF', ink: '#111111', accent: '#3A5DA8' },
    praiseWord: 'Банана!',
  },
  jedi: {
    id: 'jedi', label: 'Джедай',
    currencyName: 'кристаллы', currencyEmoji: '💎',
    voice: 'calm', stepGranularity: 'coarse', tts: false,
    colors: { primary: '#12203F', secondary: '#4FC3F7', bg: '#0B1220', ink: '#E8EEF7', accent: '#5BE37D' },
    praiseWord: 'Ты справился.',
  },
};
export const THEME_IDS = Object.keys(THEMES);
// ВАЖНО: у профиля НЕТ темы по умолчанию. Тема — выбор самого ребёнка на входе
// («Кто ты сегодня?»), а не настройка, которую задаёт родитель. Эта константа —
// только фолбэк отрисовки, пока выбор не сделан.
export const FALLBACK_THEME = 'minion';
export function theme(id) { return THEMES[id] || THEMES[FALLBACK_THEME]; }
export function isValidTheme(id) { return Object.prototype.hasOwnProperty.call(THEMES, id); }
export function normalizeTheme(id) { return isValidTheme(id) ? id : null; }

// Ранги Джедая (§37) — прогресс только растёт.
export const JEDI_RANKS = ['Юнлинг', 'Падаван', 'Рыцарь', 'Мастер'];
export function rankForCleanups(n) {
  const c = Number(n) || 0;
  if (c >= 60) return JEDI_RANKS[3];
  if (c >= 25) return JEDI_RANKS[2];
  if (c >= 8) return JEDI_RANKS[1];
  return JEDI_RANKS[0];
}

// ── Награды (§317). Валюта начисляется только за ЗАКРЫТЫЕ шаги. ──────────────
// ДВА числа, а не одно:
//   currency    — БАЛАНС: сколько можно потратить на реальную награду сейчас;
//   earnedTotal — сколько заработано ЗА ВСЁ ВРЕМЯ: не убывает никогда.
// Разделены ради покупок: тратить надо, а обнулять достигнутое нельзя (§336).
// Ранг и «сколько ты уже наработал» считаются от earnedTotal и cleanupsTotal —
// покупка мороженого не понижает ребёнка из Рыцаря обратно в Падаваны.
export const SPARKLES = { step: 1, room: 5, day: 15 };
export function sparklesFor(kind) { return SPARKLES[kind] || 0; }

// Что принадлежит РЕБЁНКУ, а что ТЕМЕ:
//   валюта, счётчик уборок, реальные награды — общие: ребёнок один, тему он
//   меняет как настроение, и прогресс за это не должен теряться (§49);
//   коллекция карточек — своя у каждой темы: у миньонов свои существа, у
//   джедаев свои. Смена темы показывает другую витрину, ничего не отнимая.
export function emptyRewards() {
  return {
    currency: 0,      // баланс: тратится покупками
    earnedTotal: 0,   // заработано за всё время: только растёт
    cleanupsTotal: 0,
    cardsByTheme: Object.fromEntries(THEME_IDS.map(t => [t, []])),
    realRewards: [],   // покупки реальных наград, см. js/shop-core.js
    dailyRooms: { day: null, rooms: {}, places: {} }, // дневной лимит, см. js/limits-core.js
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
  for (const t of THEME_IDS) {
    const list = r.cardsByTheme?.[t];
    if (Array.isArray(list)) byTheme[t] = list.slice();
  }
  if (Array.isArray(r.cards) && r.cards.length) {
    const legacy = byTheme[FALLBACK_THEME] || [];
    byTheme[FALLBACK_THEME] = Array.from(new Set([...legacy, ...r.cards]));
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
    lastSurpriseAt: r.lastSurpriseAt || null,
  };
}
// Коллекция конкретной темы (витрина, куда ребёнок возвращается).
export function cardsForTheme(rewards, themeId) {
  return normalizeRewards(rewards).cardsByTheme[normalizeTheme(themeId) || FALLBACK_THEME] || [];
}
// Чистое добавление карточки в коллекцию темы (без дублей). Вход не мутирует.
export function addCard(rewards, themeId, cardId) {
  const out = normalizeRewards(rewards);
  const t = normalizeTheme(themeId) || FALLBACK_THEME;
  if (cardId && !out.cardsByTheme[t].includes(cardId)) out.cardsByTheme[t] = [...out.cardsByTheme[t], cardId];
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

// Санитайзинг ответа /scan (§246/§276): отбрасываем неизвестные категории и
// кривые координаты, чтобы клиент рисовал только валидные подсветки.
export function sanitizeScan(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const mode = r.mode === 'overview' ? 'overview' : 'closeup';
  if (mode === 'overview') {
    const route = (Array.isArray(r.route) ? r.route : [])
      .filter(s => s && isValidActionCategory(s.category) && Array.isArray(s.point) && s.point.length === 2)
      .map((s, i) => ({
        step: Number.isInteger(s.step) ? s.step : i + 1,
        label: String(s.label || '').trim(),
        point: s.point.map(Number),
        action: String(s.action || '').trim(),
        category: normalizeActionCategory(s.category),
      }));
    return { mode, route, place: cleanPlace(r.place), estimated_minutes: Number(r.estimated_minutes) || null };
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
  return { mode, items, groups, place: cleanPlace(r.place), surface_state: r.surface_state === 'clean' ? 'clean' : 'messy' };
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

// Санитайзинг ответа /verify (§292): мягкая оценка, статусы done/retake.
export const VERIFY_SCORES = ['great', 'good', 'ok'];
export function sanitizeVerify(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  if (r.person_detected === true) return { done: false, status: 'person', praise: '', missed: [] };
  if (r.retake === true || r.status === 'retake') return { done: false, status: 'retake', praise: '', missed: [] };
  return {
    done: r.done === true,
    status: r.done === true ? 'done' : 'incomplete',
    score: VERIFY_SCORES.includes(r.score) ? r.score : 'ok',
    praise: String(r.praise || '').trim(),
    // §296: при done:false называть ОДНУ вещь, не список.
    missed: Array.isArray(r.missed) ? r.missed.slice(0, 1).map(String) : [],
  };
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
export const ROOM_TYPE_LABELS = {
  kitchen: 'Кухня', bedroom_child: 'Детская', bathroom: 'Ванная',
  living: 'Гостиная', hall: 'Прихожая', utility: 'Хозяйственная', other: 'Другое',
};
export function roomTypeLabel(t) { return ROOM_TYPE_LABELS[t] || ROOM_TYPE_LABELS.other; }

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
