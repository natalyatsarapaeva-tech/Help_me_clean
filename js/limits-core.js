// Дневной лимит уборок одной комнаты (без Firebase/DOM, тестируется в Node).
//
// Дыра, которую он закрывает: за одну и ту же полку можно было получать награду
// сколько угодно раз подряд — снял, «убрал», снял снова. Мотивация от этого не
// растёт, а обесценивается: искорка перестаёт означать работу.
//
// Правило: НАГРАДУ (искорки, карточку, счётчик уборок) даём максимум за две
// уборки ОДНОЙ КОМНАТЫ в день. Ключ — комната, а не поверхность: похожие столы
// в разных комнатах не должны блокировать друг друга.
//
// Чего лимит НЕ делает:
//   — не запрещает убираться. Ребёнок может сколько угодно; просто третья
//     уборка той же комнаты за день не приносит награды, и это говорится
//     заранее, а не «сюрпризом» в конце;
//   — не отнимает уже полученное (§336).
//
// Счётчик живёт в наградах ребёнка: rewards.dailyRooms = { day, rooms }.
// Хранится ТОЛЬКО сегодняшний день — вчерашние числа никому не нужны, а
// документ не должен расти бесконечно.
import { normalizeRewards } from './family-core.js';
import { applyRoundToRewards } from './round-core.js';

export const ROOM_DAILY_LIMIT = 2;

// Локальная дата: «день» для ребёнка — это его день, а не UTC-сутки.
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Уборка без карты дома тоже считается: иначе лимит обходится одним отказом
// выбрать комнату.
export function roomKey(roomId) { return String(roomId || '__no_room'); }

export function roomCount(rewards, roomId, now = Date.now) {
  const r = normalizeRewards(rewards);
  const today = dayKey(now());
  if (r.dailyRooms.day !== today) return 0; // другой день — счёт с нуля
  return r.dailyRooms.rooms[roomKey(roomId)] || 0;
}
export function roomsLeft(rewards, roomId, { now = Date.now, limit = ROOM_DAILY_LIMIT } = {}) {
  return Math.max(0, limit - roomCount(rewards, roomId, now));
}
export function isRoomExhausted(rewards, roomId, { now = Date.now, limit = ROOM_DAILY_LIMIT } = {}) {
  return roomCount(rewards, roomId, now) >= limit;
}

// Отметить уборку комнаты. При смене дня старые числа выбрасываются целиком.
export function registerRoomCleanup(rewards, roomId, { now = Date.now } = {}) {
  const out = normalizeRewards(rewards);
  const today = dayKey(now());
  const rooms = out.dailyRooms.day === today ? { ...out.dailyRooms.rooms } : {};
  const key = roomKey(roomId);
  rooms[key] = (rooms[key] || 0) + 1;
  out.dailyRooms = { day: today, rooms };
  return out;
}

// Единая точка начисления за раунд: сначала лимит, потом награда.
// Возвращает и решение, и причину — экрану есть что сказать ребёнку.
export function awardRound(rewards, round, { now = Date.now, limit = ROOM_DAILY_LIMIT } = {}) {
  const roomId = round?.roomId || null;
  const before = roomCount(rewards, roomId, now);
  if (before >= limit) {
    // Раунд честно записывается в историю, но награды за него нет.
    return { rewards: normalizeRewards(rewards), awarded: false, reason: 'room-limit', count: before, limit };
  }
  const next = registerRoomCleanup(applyRoundToRewards(rewards, round), roomId, { now });
  return { rewards: next, awarded: true, reason: null, count: before + 1, limit };
}
