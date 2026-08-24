// Чистое ядро ТЕМ семьи (без Firebase/DOM, тестируется в Node).
//
// Тема больше не зашита в код. Раньше их было ровно две — Миньон и Джедай, —
// и обе тащили франшизные отсылки, которых у приложения нет права носить (§51).
// Теперь тему собирает РОДИТЕЛЬ: имя, палитра, названия рангов и карточки.
// Ребёнок по-прежнему выбирает образ сам на входе («Кто ты сегодня?», §24) —
// но выбирает из того, что семья придумала под его интересы.
//
//   families/{fid}/settings/app  →  themes: [ {id, name, emoji, colors, ranks} ]
//
// Почему максимум четыре: экран выбора образа — это ряд крупных кнопок для
// ребёнка, а не список. Пять «кто ты сегодня» — уже прокрутка и выбор из
// каталога, а не «я сегодня динозавр».
import { t } from './i18n.js';

export const MAX_THEMES = 4;
export const RANK_COUNT = 4;   // порогов роста четыре, см. RANK_THRESHOLDS
export const NAME_MAX = 24;
export const RANK_NAME_MAX = 20;

// ── Палитра ─────────────────────────────────────────────────────────────────
// Двенадцать цветов вместо свободного колеса: родитель выбирает НАЗВАННЫЙ цвет,
// а не крутит пипетку до нечитаемого сочетания. Все двенадцать проверены на
// белом фоне и с крупным жирным шрифтом — тема не может получиться слепой.
// Подписи — в словаре (palette.<id>), сами значения цветом не переводятся.
export const PALETTE = [
  { id: 'sun',    hex: '#FFD836' },
  { id: 'orange', hex: '#F0871E' },
  { id: 'coral',  hex: '#E5533D' },
  { id: 'pink',   hex: '#F472B6' },
  { id: 'purple', hex: '#7C3AED' },
  { id: 'blue',   hex: '#3A5DA8' },
  { id: 'sky',    hex: '#4FC3F7' },
  { id: 'teal',   hex: '#00ACC1' },
  { id: 'mint',   hex: '#5BE37D' },
  { id: 'grass',  hex: '#25A55A' },
  { id: 'earth',  hex: '#8D6E63' },
  { id: 'night',  hex: '#12203F' },
];
export const PALETTE_IDS = PALETTE.map(c => c.id);
const PALETTE_BY_ID = new Map(PALETTE.map(c => [c.id, c]));
export function isPaletteColor(id) { return PALETTE_BY_ID.has(String(id)); }
export function paletteHex(id, fallback = 'blue') {
  return (PALETTE_BY_ID.get(String(id)) || PALETTE_BY_ID.get(fallback)).hex;
}
export function paletteLabel(id) { return t(`palette.${id}`); }
// Три роли цвета: главный (кнопки), второй (обводки и заголовки), акцент
// (подсветка, прогресс, «получилось»). Больше трёх родителю не нужно.
export const COLOR_ROLES = ['primary', 'secondary', 'accent'];

// Значок валюты темы — короткий список вместо клавиатуры эмодзи: значок
// попадает в счётчик искорок на каждом экране, и «случайно вставленный смайл
// из буфера» там нежелателен.
export const THEME_EMOJI = ['✨', '⭐', '💎', '🍀', '🔥', '🌈', '🐾', '🚀', '🌸', '🍌', '🦕', '⚡'];
export const DEFAULT_EMOJI = '✨';

// ── Пресеты: с чем семья открывает приложение в первый раз ───────────────────
// Не «наш контент», а два готовых набора цветов, чтобы можно было начать
// убираться до того, как родитель дойдёт до экрана тем. Имена нейтральные:
// «Миньона» и «Джедая» вписывает сама семья, если хочет (§51).
// id сохранены как ключи коллекций карточек — их видит cardsByTheme.
export const PRESET_IDS = ['sunny', 'starry'];
const PRESETS = {
  sunny: {
    emoji: '⭐',
    colors: { primary: 'sun', secondary: 'blue', accent: 'orange' },
    voice: 'loud', stepGranularity: 'fine', tts: true,
  },
  starry: {
    emoji: '💎',
    colors: { primary: 'night', secondary: 'sky', accent: 'mint' },
    voice: 'calm', stepGranularity: 'coarse', tts: false,
  },
};
export function defaultThemes() {
  return PRESET_IDS.map(id => ({
    id,
    preset: id,
    name: '',                    // пусто = «подписать из словаря», см. resolveTheme
    emoji: PRESETS[id].emoji,
    colors: { ...PRESETS[id].colors },
    ranks: ['', '', '', ''],     // пусто = общие названия рангов из словаря
  }));
}

// Старые документы знают темы под франшизными id. Ключи коллекций карточек и
// lastTheme в профилях переписывать в базе не нужно — достаточно понимать их
// при чтении: добытое не отнимается ни при каких переименованиях (§336).
const LEGACY_THEME_IDS = { minion: 'sunny', jedi: 'starry' };
export function migrateLegacyThemeId(id) {
  const s = String(id || '');
  return LEGACY_THEME_IDS[s] || s;
}

// ── Нормализация ────────────────────────────────────────────────────────────
function cleanText(raw, max) { return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanEmoji(raw) {
  const e = String(raw ?? '').trim();
  return e ? [...e][0] : DEFAULT_EMOJI;   // ровно один значок, а не строка
}
function cleanColors(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const fallback = PRESETS.sunny.colors;
  return Object.fromEntries(COLOR_ROLES.map(role =>
    [role, isPaletteColor(c[role]) ? String(c[role]) : fallback[role]]));
}
function cleanRanks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: RANK_COUNT }, (_, i) => cleanText(list[i], RANK_NAME_MAX));
}

// Документ темы → предсказуемая форма. Тема без id — не тема: id связывает её с
// коллекцией карточек ребёнка, поэтому чинить его выдумкой нельзя.
export function normalizeTheme(raw) {
  const th = (raw && typeof raw === 'object') ? raw : {};
  const id = String(th.id || '').trim();
  if (!id) return null;
  const preset = PRESET_IDS.includes(th.preset) ? th.preset : null;
  return {
    id,
    preset,
    name: cleanText(th.name, NAME_MAX),
    emoji: cleanEmoji(th.emoji ?? (preset ? PRESETS[preset].emoji : DEFAULT_EMOJI)),
    colors: cleanColors(th.colors ?? (preset ? PRESETS[preset].colors : null)),
    ranks: cleanRanks(th.ranks),
  };
}

// Список тем семьи: без дублей id, не длиннее лимита. Пустой список — это не
// «тем нет», а «семья ещё не настраивала»: отдаём пресеты, иначе ребёнку не из
// чего выбрать образ и приложение встанет на первом же экране.
export function normalizeThemes(raw) {
  const seen = new Set();
  const list = (Array.isArray(raw) ? raw : [])
    .map(normalizeTheme)
    .filter(th => th && !seen.has(th.id) && seen.add(th.id))
    .slice(0, MAX_THEMES);
  return list.length ? list : defaultThemes();
}

// ── Отрисовка темы ──────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) || 0);
}
const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
// Смешать два цвета: 0 — целиком первый, 1 — целиком второй.
export function mixHex(a, b, ratio) {
  const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, Number(ratio) || 0));
  return `#${toHex(r1 + (r2 - r1) * k)}${toHex(g1 + (g2 - g1) * k)}${toHex(b1 + (b2 - b1) * k)}`.toUpperCase();
}
// Относительная яркость (WCAG) — чтобы текст на кнопке выбирался расчётом, а не
// на глаз: жёлтая кнопка требует чёрных букв, тёмно-синяя — белых.
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const INK = '#111111';
export const PAPER = '#FFFFFF';
// Порог не «на глаз» (0.5), а точка, где контраст с чёрным сравнивается с
// контрастом с белым: (L+0.05)² = 1.05·0.05 → L ≈ 0.179. На жёлтой и оранжевой
// кнопке это даёт чёрные буквы, на тёмно-синей — белые, и любой цвет палитры
// проходит порог WCAG AA (проверено тестом).
export function readableInk(hex) { return luminance(hex) > 0.179 ? INK : PAPER; }

// Полный набор CSS-переменных темы. Родитель выбирает три цвета — остальное
// (фон, буквы, карточки, линии) считается от них: фон всегда светлый, потому
// что ребёнок смотрит на этот экран днём и с ним рядом взрослый с телефоном,
// а тёмная тема на дешёвом планшете чаще всего просто тусклая.
export function themeCssVars(themeLike) {
  const th = normalizeTheme(themeLike) || defaultThemes()[0];
  const primary = paletteHex(th.colors.primary);
  const secondary = paletteHex(th.colors.secondary);
  const accent = paletteHex(th.colors.accent);
  return {
    '--primary': primary,
    '--secondary': secondary,
    '--accent': accent,
    '--bg': PAPER,
    '--ink': INK,
    '--card': mixHex(primary, PAPER, 0.9),
    '--line': mixHex(primary, PAPER, 0.74),
    '--muted': mixHex(INK, PAPER, 0.55),
    '--primary-ink': readableInk(primary),
  };
}

// Тема → то, что рисует экран. Подписи берутся из документа семьи, а пустые —
// из словаря: пресет остаётся переведённым на оба языка, пока его не переименуют.
export function resolveTheme(themeLike) {
  const th = normalizeTheme(themeLike) || defaultThemes()[0];
  const preset = th.preset;
  const meta = preset ? PRESETS[preset] : null;
  return {
    ...th,
    label: th.name || (preset ? t(`theme.${preset}.label`) : t('themes.untitled')),
    currencyEmoji: th.emoji,
    currencyName: preset ? t(`theme.${preset}.currencyName`) : t('themes.currency'),
    praiseWord: preset ? t(`theme.${preset}.praiseWord`) : t('themes.praise'),
    ranks: themeRanks(th),
    voice: meta?.voice || 'calm',
    stepGranularity: meta?.stepGranularity || 'fine',
    tts: meta ? meta.tts : true,
    colors: themeCssVars(th),
    palette: { ...th.colors },
  };
}
// Названия рангов: своё — если родитель его вписал, общее из словаря — если нет.
// Пропуск в середине не ломает лестницу: «Новичок → Хищник → Мастер → Хранитель».
export function themeRanks(themeLike) {
  const th = normalizeTheme(themeLike) || defaultThemes()[0];
  return th.ranks.map((name, i) => name || t(`rank.${i + 1}`));
}

// ── Правка списка тем родителем ─────────────────────────────────────────────
// id — человекочитаемый и стабильный: он же ключ коллекции карточек ребёнка,
// поэтому переименование темы его НЕ меняет (иначе витрина обнулится).
export function makeThemeId(name, rand = Math.random) {
  const slug = String(name || 'theme').toLowerCase()
    .replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'theme';
  return `${slug.slice(0, 16)}-${Math.floor(rand() * 1e6).toString(36)}`;
}

// Что мешает сохранить тему. Имя обязательно: тема без имени — это кнопка
// «Кто ты сегодня?» без подписи.
export function validateTheme(draft, list = [], { id = null } = {}) {
  const name = cleanText(draft?.name, NAME_MAX);
  if (!name) return 'name-required';
  const taken = normalizeThemes(list)
    .filter(th => th.id !== id)
    .some(th => resolveTheme(th).label.toLowerCase() === name.toLowerCase());
  return taken ? 'name-taken' : null;
}

export function canAddTheme(list) { return normalizeThemes(list).length < MAX_THEMES; }

// Добавление, правка, удаление — чистые: вход не мутируют, возвращают
// { themes, error }. Ошибка — код для словаря, а не текст.
export function addTheme(list, draft, { rand = Math.random } = {}) {
  const themes = normalizeThemes(list);
  if (!canAddTheme(themes)) return { themes, error: 'limit' };
  const error = validateTheme(draft, themes);
  if (error) return { themes, error };
  const th = normalizeTheme({ ...draft, id: draft?.id || makeThemeId(draft?.name, rand), preset: null });
  return { themes: [...themes, th], error: null };
}

export function updateTheme(list, id, patch) {
  const themes = normalizeThemes(list);
  const i = themes.findIndex(th => th.id === id);
  if (i < 0) return { themes, error: 'not-found' };
  // Правка ИМЕНИ снимает пресет: переименованный «Солнечный» больше не должен
  // переводиться словарём — родитель назвал тему сам, на своём языке.
  const merged = { ...themes[i], ...patch, id: themes[i].id };
  if (patch && 'name' in patch && cleanText(patch.name, NAME_MAX)) merged.preset = null;
  const error = validateTheme({ ...merged, name: merged.name || resolveTheme(themes[i]).label }, themes, { id });
  if (error) return { themes, error };
  const next = themes.slice();
  next[i] = normalizeTheme(merged);
  return { themes: next, error: null };
}

// Последнюю тему удалить нельзя: без единого образа ребёнку не во что играть.
export function removeTheme(list, id) {
  const themes = normalizeThemes(list);
  if (!themes.some(th => th.id === id)) return { themes, error: 'not-found' };
  if (themes.length <= 1) return { themes, error: 'last' };
  return { themes: themes.filter(th => th.id !== id), error: null };
}

// Заготовка новой темы для экрана родителя: цвета не «первые попавшиеся», а
// ещё не занятые другими темами — четыре одинаково-синих образа ребёнок не
// различит.
export function draftTheme(list) {
  const themes = normalizeThemes(list);
  const used = new Set(themes.flatMap(th => Object.values(th.colors)));
  const free = PALETTE_IDS.filter(id => !used.has(id));
  const pick = (i, fallback) => free[i] || PALETTE_IDS[(PALETTE_IDS.indexOf(fallback) + themes.length) % PALETTE_IDS.length];
  return {
    id: null,
    preset: null,
    name: '',
    emoji: THEME_EMOJI[themes.length % THEME_EMOJI.length],
    colors: { primary: pick(0, 'sun'), secondary: pick(1, 'blue'), accent: pick(2, 'mint') },
    ranks: ['', '', '', ''],
  };
}
