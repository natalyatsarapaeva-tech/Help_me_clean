// Чистое ядро КОЛЛЕКЦИИ карточек (без Firebase/DOM, тестируется в Node).
//
// Карточки не зашиты в код: их загружает родитель (themes.html) — фото наклейки,
// рисунка, кадра из мультика, снимка самого ребёнка. Поэтому приложению не нужно
// придумывать существ и не нужно тащить франшизные отсылки (§51): каталог —
// это данные семьи, а не наш контент.
//
//   families/{fid}/cards/{cardId}          — каталог семьи (пишет родитель)
//   .../profiles/{pid}/rewards/current
//        cardsByTheme: { <themeId>: [cardId] }     — что ребёнок УЖЕ добыл
//
// Карточка принадлежит теме (§49): у «динозавров» своя витрина, у «космоса»
// своя. 'any' — карточка, которая может выпасть в любой теме (её удобно давать
// семейным фото и всему, что не привязано к одному образу).
//
// Темы у каждой семьи свои и правятся на themes.html, поэтому список тем
// карточки — ФУНКЦИЯ, а не константа: он меняется, пока приложение открыто.
import { themeIds, isValidTheme, fallbackThemeId } from './family-core.js';
import { migrateLegacyThemeId } from './themes-core.js';

export const CARD_ANY = 'any';
export function cardThemes() { return [CARD_ANY, ...themeIds()]; }
export function isValidCardTheme(t) { return cardThemes().includes(t); }
export function normalizeCardTheme(t) {
  const id = migrateLegacyThemeId(t);
  return isValidCardTheme(id) ? id : CARD_ANY;
}

// Приведение документа карточки к предсказуемой форме: экран рисует только то,
// у чего есть картинка и id.
export function normalizeCard(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const id = String(c.id || '').trim();
  if (!id || !c.url) return null;
  return {
    id,
    name: String(c.name || '').trim(),
    theme: normalizeCardTheme(c.theme),
    url: String(c.url),
    path: c.path ? String(c.path) : null,
    createdAt: c.createdAt || null,
  };
}
export function normalizeCatalog(raw) {
  return (Array.isArray(raw) ? raw : []).map(normalizeCard).filter(Boolean);
}

// Витрина образа: карточки этого образа + общие. Порядок каталога сохраняем —
// родитель загружал их в каком-то своём порядке, и он осмысленный.
export function cardsPool(catalog, themeId) {
  const t = isValidTheme(themeId) ? migrateLegacyThemeId(themeId) : fallbackThemeId();
  return normalizeCatalog(catalog).filter(c => c.theme === t || c.theme === CARD_ANY);
}
// Что ещё можно добыть в этом образе.
export function availableCards(catalog, themeId, ownedIds) {
  const owned = new Set(Array.isArray(ownedIds) ? ownedIds : []);
  return cardsPool(catalog, themeId).filter(c => !owned.has(c.id));
}

// Выдача карточки за подтверждённую уборку. Случайность подаётся извне
// (детерминизм в тестах). Коллекция собрана — null: молча ничего не выдаём,
// экран скажет «ты собрал всё», а не покажет пустую награду.
export function pickCard(catalog, themeId, ownedIds, rand = Math.random) {
  const pool = availableCards(catalog, themeId, ownedIds);
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

// Модель витрины для экрана коллекции: добытые — как есть, недобытые — силуэтом.
// Показывать закрытые слоты важно: видно, что коллекция продолжается (§336).
export function collectionView(catalog, themeId, ownedIds) {
  const owned = new Set(Array.isArray(ownedIds) ? ownedIds : []);
  const cards = cardsPool(catalog, themeId).map(c => ({ ...c, owned: owned.has(c.id) }));
  const got = cards.filter(c => c.owned).length;
  return {
    cards,
    got,
    total: cards.length,
    complete: cards.length > 0 && got === cards.length,
    // Карточки, добытые в этом образе, но которых уже нет в каталоге (родитель
    // удалил): в витрине их не показываем, но и из наград не вычищаем — отнимать
    // добытое нельзя (§336).
    orphans: (Array.isArray(ownedIds) ? ownedIds : []).filter(id => !cards.some(c => c.id === id)),
  };
}

// Сводка по всем образам — для родителя: «сколько всего загружено и куда».
export function catalogSummary(catalog) {
  const all = normalizeCatalog(catalog);
  const byTheme = Object.fromEntries(cardThemes().map(t => [t, all.filter(c => c.theme === t).length]));
  return { total: all.length, byTheme };
}

// id карточки из имени файла/названия — человекочитаемый и стабильный.
export function makeCardId(name, rand = Math.random) {
  const slug = String(name || 'card').toLowerCase()
    .replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'card';
  return `${slug.slice(0, 24)}-${Math.floor(rand() * 1e6).toString(36)}`;
}
