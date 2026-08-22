// Чистое ядро ПРОФИЛЕЙ на общем планшете (без Firebase/DOM, тестируется в Node).
//
// Модель входа (после отказа от служебных детских аккаунтов):
//   планшет один раз логинится РОДИТЕЛЕМ → дальше это семейное устройство;
//   ребёнок не логинится, а ВЫБИРАЕТ СЕБЯ на экране аватаров и набирает свой PIN;
//   родительская часть (дом, дети, карточки, награды, эталоны) — за отдельным PIN.
//
// Профиль перестал быть пользователем: `profiles/{profileId}` — просто документ.
// У старых профилей id совпадает с uid прежнего детского аккаунта, и это
// нормально: прогресс, искорки и коллекции привязаны к id, а не к способу входа.
import { normalizeTheme } from './family-core.js';

export function makeProfileId(name, rand = Math.random) {
  const slug = String(name || 'kid').toLowerCase()
    .replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'kid';
  return `${slug.slice(0, 20)}-${Math.floor(rand() * 1e6).toString(36)}`;
}

export function normalizeProfile(raw) {
  const p = (raw && typeof raw === 'object') ? raw : {};
  const id = String(p.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(p.name || '').trim(),
    avatar: String(p.avatar || '🧒'),
    lastTheme: normalizeTheme(p.lastTheme),
    homeRoomId: p.homeRoomId || null,
    routeOrder: Array.isArray(p.routeOrder) ? p.routeOrder : [],
    // Замок профиля: { salt, hash } или null. Хранится хэш, не сам PIN (js/pin.js).
    pin: (p.pin?.salt && p.pin?.hash) ? { salt: String(p.pin.salt), hash: String(p.pin.hash) } : null,
    createdAt: p.createdAt || null,
  };
}
export function normalizeProfiles(list) {
  return (Array.isArray(list) ? list : []).map(normalizeProfile).filter(Boolean)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export function isLocked(profile) { return !!normalizeProfile(profile)?.pin; }

// Кого показывать выбранным при открытии приложения: сохранённого, если он ещё
// существует; иначе никого — пусть выберут заново, а не «свалятся» в чужой профиль.
export function pickActiveProfile(profiles, savedId) {
  const list = normalizeProfiles(profiles);
  if (!list.length) return null;
  return list.some(p => p.id === savedId) ? savedId : null;
}
export function findProfile(profiles, id) {
  return normalizeProfiles(profiles).find(p => p.id === id) || null;
}

// Родительский замок лежит в настройках семьи (settings/app.parentPin).
export function parentLock(settings) {
  const p = settings?.parentPin;
  return (p?.salt && p?.hash) ? { salt: String(p.salt), hash: String(p.hash) } : null;
}
// Пока родительский PIN не задан, родительская часть открыта: иначе первый же
// родитель запрёт сам себя. Экран об этом честно предупреждает и предлагает задать.
export function parentAreaLocked(settings) { return !!parentLock(settings); }
