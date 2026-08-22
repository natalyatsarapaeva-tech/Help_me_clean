// Дневной лимит уборок одной комнаты (без Firebase/DOM, тестируется в Node).
//
// Дыра, которую он закрывает: за одну и ту же полку можно было получать награду
// сколько угодно раз подряд — снял, «убрал», снял снова. Мотивация от этого не
// растёт, а обесценивается: искорка перестаёт означать работу.
//
// Правило: НАГРАДУ (искорки, карточку, счётчик уборок) даём максимум за две
// уборки ОДНОГО МЕСТА в день. Место — то, что сканер увидел в кадре («раковина»,
// «стол у окна»): у комнаты много углов, и запирать её целиком после двух
// уборок неправильно — там ещё пол, полки и подоконник.
//
// Почему место определяет модель, а не сравнение фотографий: вызов сканера и так
// летит на каждый кадр, и короткое имя места едет в том же ответе почти даром.
// Сравнивать сами фото пришлось бы либо ещё одним vision-вызовом (дорого), либо
// перцептивным хэшем на клиенте (бесплатно, но разваливается от смены ракурса —
// а ребёнок снимает как придётся).
//
// Модель может назвать один и тот же угол по-разному («раковина» / «умывальник»)
// и так обойти лимит. От этого — страховка: щедрый предел на комнату целиком.
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
import { normalizeRewards, cleanPlace } from './family-core.js';
import { applyRoundToRewards } from './round-core.js';

export const PLACE_DAILY_LIMIT = 2;  // одно место — две награждаемые уборки в день
export const ROOM_DAILY_LIMIT = 6;   // страховка на всю комнату, если места «поплыли»

// Локальная дата: «день» для ребёнка — это его день, а не UTC-сутки.
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Уборка без карты дома тоже считается: иначе лимит обходится одним отказом
// выбрать комнату.
export function roomKey(roomId) { return String(roomId || '__no_room'); }
// Ключ места: комната + имя места. Без имени (сканер не назвал) — общий ключ
// комнаты, то есть поведение как раньше.
export function placeKey(roomId, place) {
  const p = cleanPlace(place);
  return `${roomKey(roomId)}::${p || '*'}`;
}

function todayCounters(rewards, now) {
  const r = normalizeRewards(rewards);
  return r.dailyRooms.day === dayKey(now()) ? r.dailyRooms : { day: null, rooms: {}, places: {} };
}

export function roomCount(rewards, roomId, now = Date.now) {
  return todayCounters(rewards, now).rooms[roomKey(roomId)] || 0;
}
export function placeCount(rewards, roomId, place, now = Date.now) {
  return todayCounters(rewards, now).places[placeKey(roomId, place)] || 0;
}
export function placesLeft(rewards, roomId, place, { now = Date.now, limit = PLACE_DAILY_LIMIT } = {}) {
  return Math.max(0, limit - placeCount(rewards, roomId, place, now));
}
export function isPlaceExhausted(rewards, roomId, place, { now = Date.now, limit = PLACE_DAILY_LIMIT } = {}) {
  return placeCount(rewards, roomId, place, now) >= limit;
}
export function roomsLeft(rewards, roomId, { now = Date.now, limit = ROOM_DAILY_LIMIT } = {}) {
  return Math.max(0, limit - roomCount(rewards, roomId, now));
}
export function isRoomExhausted(rewards, roomId, { now = Date.now, limit = ROOM_DAILY_LIMIT } = {}) {
  return roomCount(rewards, roomId, now) >= limit;
}

// Отметить уборку места (и комнаты). При смене дня старые числа выбрасываются.
export function registerCleanup(rewards, roomId, place, { now = Date.now } = {}) {
  const out = normalizeRewards(rewards);
  const today = dayKey(now());
  const fresh = out.dailyRooms.day === today;
  const rooms = fresh ? { ...out.dailyRooms.rooms } : {};
  const places = fresh ? { ...out.dailyRooms.places } : {};
  const rk = roomKey(roomId), pk = placeKey(roomId, place);
  rooms[rk] = (rooms[rk] || 0) + 1;
  places[pk] = (places[pk] || 0) + 1;
  out.dailyRooms = { day: today, rooms, places };
  return out;
}

// Единая точка начисления за раунд: сначала лимит, потом награда.
// Возвращает и решение, и причину — экрану есть что сказать ребёнку.
export function awardRound(rewards, round, {
  now = Date.now, placeLimit = PLACE_DAILY_LIMIT, roomLimit = ROOM_DAILY_LIMIT,
} = {}) {
  const roomId = round?.roomId || null;
  const place = round?.place || '';
  const atPlace = placeCount(rewards, roomId, place, now);
  const atRoom = roomCount(rewards, roomId, now);
  // Раунд в любом случае состоялся и попадёт в историю — не награждаем, но и
  // не запрещаем: «нельзя убираться» было бы абсурдным запретом.
  if (atPlace >= placeLimit) {
    return { rewards: normalizeRewards(rewards), awarded: false, reason: 'place-limit', place, count: atPlace, limit: placeLimit };
  }
  if (atRoom >= roomLimit) {
    return { rewards: normalizeRewards(rewards), awarded: false, reason: 'room-limit', place, count: atRoom, limit: roomLimit };
  }
  const next = registerCleanup(applyRoundToRewards(rewards, round), roomId, place, { now });
  return { rewards: next, awarded: true, reason: null, place, count: atPlace + 1, limit: placeLimit };
}
