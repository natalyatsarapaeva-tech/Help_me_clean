// Тесты реальных наград и дневного лимита (node --test, без Firebase/DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRealReward, normalizeShop, makeRewardId, canAfford, buyReward,
  purchases, pendingPurchases, givenPurchases, markGiven, shopView,
} from '../js/shop-core.js';
import {
  PLACE_DAILY_LIMIT, ROOM_DAILY_LIMIT, dayKey, roomKey, placeKey,
  roomCount, placeCount, placesLeft, isPlaceExhausted, isRoomExhausted,
  registerCleanup, awardRound,
} from '../js/limits-core.js';
import { emptyRewards, normalizeRewards, addSparkles, rankForCleanups, SPARKLES } from '../js/family-core.js';
import { buildRound, completeStep, finishRound } from '../js/round-core.js';
import { sanitizeScan } from '../js/family-core.js';

const at = (t) => () => t;
const rich = (currency = 100, earned = 100) => ({ ...emptyRewards(), currency, earnedTotal: earned, cleanupsTotal: 30 });

// ── Баланс и «заработано за всё время» ──────────────────────────────────────
test('два числа: баланс тратится, заработанное — нет', () => {
  const r = addSparkles(addSparkles(emptyRewards(), 'room'), 'room');
  assert.equal(r.currency, 10);
  assert.equal(r.earnedTotal, 10, 'растут вместе');
  const { rewards: after } = buyReward(r, { id: 'ice', name: 'Мороженое', cost: 7 }, { now: at(1000) });
  assert.equal(after.currency, 3, 'баланс уменьшился');
  assert.equal(after.earnedTotal, 10, 'заработанное за всё время не тронуто');
  assert.equal(after.cleanupsTotal, r.cleanupsTotal, 'счётчик уборок не тронут');
});

test('ранг считается от уборок и покупкой не понижается', () => {
  const before = rankForCleanups(rich().cleanupsTotal);
  const { rewards } = buyReward(rich(), { id: 'zoo', name: 'Зоопарк', cost: 100 }, { now: at(1) });
  assert.equal(rewards.currency, 0);
  assert.equal(rankForCleanups(rewards.cleanupsTotal), before, 'Рыцарь не разжалован за мороженое');
});

test('миграция старых наград: earnedTotal подтягивается к балансу', () => {
  const old = normalizeRewards({ currency: 42, cleanupsTotal: 5 }); // документ до покупок
  assert.equal(old.earnedTotal, 42);
  assert.equal(normalizeRewards({ currency: 10, earnedTotal: 3 }).earnedTotal, 10,
    'earnedTotal не может быть меньше баланса');
});

// ── Витрина ─────────────────────────────────────────────────────────────────
test('награда без имени или с нулевой ценой не попадает на витрину', () => {
  assert.equal(normalizeRealReward({ id: 'a', name: '', cost: 5 }), null);
  assert.equal(normalizeRealReward({ id: 'a', name: 'X', cost: 0 }), null);
  assert.equal(normalizeRealReward({ name: 'X', cost: 5 }), null, 'нет id');
  assert.equal(normalizeRealReward({ id: 'a', name: 'X', cost: 5.7 }).cost, 5, 'цена — целое');
  assert.equal(normalizeRealReward({ id: 'a', name: 'X', cost: 5 }).emoji, '🎁', 'эмодзи по умолчанию');
});

test('витрина сортируется от дешёвого — ближняя цель первой', () => {
  const shop = normalizeShop([
    { id: 'zoo', name: 'Зоопарк', cost: 100 },
    { id: 'ice', name: 'Мороженое', cost: 20 },
    { id: 'film', name: 'Выбрать фильм', cost: 40 },
  ]);
  assert.deepEqual(shop.map(i => i.id), ['ice', 'film', 'zoo']);
});

test('id награды безопасен для пути', () => {
  assert.equal(makeRewardId('Мороженое', () => 0), 'reward-0');
  assert.equal(makeRewardId('Ice cream', () => 0), 'ice-cream-0');
});

// ── Покупка ─────────────────────────────────────────────────────────────────
test('не хватает искорок — покупки не происходит', () => {
  const r = rich(10);
  const res = buyReward(r, { id: 'zoo', name: 'Зоопарк', cost: 100 }, { now: at(1) });
  assert.equal(res.error, 'not-enough');
  assert.equal(res.purchase, null);
  assert.equal(res.rewards.currency, 10, 'баланс не тронут');
  assert.equal(res.rewards.realRewards.length, 0);
  assert.equal(canAfford(r, { id: 'zoo', name: 'Зоопарк', cost: 100 }), false);
  assert.equal(canAfford(r, { id: 'ice', name: 'Мороженое', cost: 10 }), true, 'ровно хватает — можно');
});

test('покупка попадает в очередь на выдачу', () => {
  const { rewards, purchase } = buyReward(rich(50), { id: 'ice', name: 'Мороженое', emoji: '🍦', cost: 20 }, { now: at(1000), rand: () => 0 });
  assert.equal(rewards.currency, 30);
  assert.equal(purchase.name, 'Мороженое');
  assert.equal(purchase.cost, 20);
  assert.equal(purchase.givenAt, null);
  assert.equal(purchase.boughtAt, new Date(1000).toISOString());
  assert.equal(pendingPurchases(rewards).length, 1);
  assert.equal(givenPurchases(rewards).length, 0);
});

test('родитель отмечает выдачу — покупка уходит из очереди, но не из истории', () => {
  const bought = buyReward(rich(50), { id: 'ice', name: 'Мороженое', cost: 20 }, { now: at(1000), rand: () => 0 });
  const given = markGiven(bought.rewards, bought.purchase.id, { now: at(2000) });
  assert.equal(pendingPurchases(given).length, 0);
  assert.equal(givenPurchases(given).length, 1);
  assert.equal(purchases(given)[0].givenAt, new Date(2000).toISOString());
  assert.equal(given.currency, 30, 'выдача баланс не трогает — он списан при покупке');
  const twice = markGiven(given, bought.purchase.id, { now: at(9999) });
  assert.equal(purchases(twice)[0].givenAt, new Date(2000).toISOString(), 'повторная отметка не переписывает время');
});

test('витрина ребёнка: что по карману, сколько не хватает, к чему копить', () => {
  const v = shopView([
    { id: 'ice', name: 'Мороженое', cost: 20 },
    { id: 'zoo', name: 'Зоопарк', cost: 100 },
  ], rich(30, 250));
  assert.equal(v.balance, 30);
  assert.equal(v.earnedTotal, 250, 'заработанное за всё время показывается отдельно');
  assert.deepEqual(v.items.map(i => i.affordable), [true, false]);
  assert.equal(v.nextGoal.id, 'zoo');
  assert.equal(v.nextGoal.missing, 70, 'до цели 70 искорок');
});

// ── Дневной лимит по МЕСТУ ──────────────────────────────────────────────────
// Лимит держит место в кадре («раковина», «стол у окна»), а не комната целиком:
// у комнаты много углов, и запирать её после двух уборок было бы неправильно.
const roundAt = (roomId, place) => {
  let r = buildRound(sanitizeScan({
    mode: 'closeup', place,
    items: [{ id: 1, label: 'чек', category: 'paper', box: [0, 0, 0.1, 0.1] }],
  }), { roomId, roomName: roomId, now: at(0), rand: () => 0 });
  r = completeStep(r, { now: at(1), rand: () => 0 });
  return finishRound(r, { done: true }, { now: at(2) });
};
const DAY1 = Date.parse('2026-08-22T10:00:00');
const DAY1_LATE = Date.parse('2026-08-22T21:00:00');
const DAY2 = Date.parse('2026-08-23T09:00:00');
const REWARD_PER_ROUND = SPARKLES.step + SPARKLES.room;

test('день локальный; ключ места переживает кавычки и регистр', () => {
  assert.equal(dayKey(Date.parse('2026-08-22T10:00:00')), '2026-08-22');
  assert.equal(roomKey(null), '__no_room', 'уборка без комнаты тоже считается');
  assert.equal(placeKey('bath', '«Раковина» '), placeKey('bath', 'раковина'),
    'одно место, названное по-разному оформленно, — один ключ');
  assert.notEqual(placeKey('bath', 'раковина'), placeKey('kitchen', 'раковина'),
    'раковина в ванной и на кухне — разные места');
  assert.equal(placeKey('bath', ''), 'bath::*', 'сканер не назвал место — считаем по комнате');
});

test('одно место — две награждаемые уборки, третья без искорок', () => {
  let rewards = emptyRewards();
  const first = awardRound(rewards, roundAt('bath', 'раковина'), { now: at(DAY1) });
  assert.ok(first.awarded);
  assert.equal(first.rewards.currency, REWARD_PER_ROUND);

  const second = awardRound(first.rewards, roundAt('bath', 'раковина'), { now: at(DAY1) });
  assert.ok(second.awarded);

  const third = awardRound(second.rewards, roundAt('bath', 'Раковина'), { now: at(DAY1_LATE) });
  assert.equal(third.awarded, false);
  assert.equal(third.reason, 'place-limit');
  assert.equal(third.limit, PLACE_DAILY_LIMIT);
  assert.equal(third.rewards.currency, REWARD_PER_ROUND * 2, 'искорки не начислены');
  assert.equal(third.rewards.earnedTotal, REWARD_PER_ROUND * 2);
  assert.equal(third.rewards.cleanupsTotal, 2, 'счётчик уборок не накручен');
});

test('другое место ТОЙ ЖЕ комнаты награждается — комната не запирается целиком', () => {
  let rewards = emptyRewards();
  rewards = awardRound(rewards, roundAt('bath', 'раковина'), { now: at(DAY1) }).rewards;
  rewards = awardRound(rewards, roundAt('bath', 'раковина'), { now: at(DAY1) }).rewards;
  assert.ok(isPlaceExhausted(rewards, 'bath', 'раковина', { now: at(DAY1) }));

  const floor = awardRound(rewards, roundAt('bath', 'пол у двери'), { now: at(DAY1) });
  assert.ok(floor.awarded, 'пол в той же ванной — своя квота');
  assert.equal(floor.rewards.currency, REWARD_PER_ROUND * 3);
  assert.equal(placesLeft(floor.rewards, 'bath', 'пол у двери', { now: at(DAY1) }), 1);
  assert.equal(placesLeft(floor.rewards, 'bath', 'раковина', { now: at(DAY1) }), 0);
  assert.equal(roomCount(floor.rewards, 'bath', at(DAY1)), 3, 'счётчик комнаты тоже растёт');
});

test('страховка: если модель называет углы всё новыми словами, комната всё же кончается', () => {
  let rewards = emptyRewards();
  for (let i = 0; i < ROOM_DAILY_LIMIT; i++) {
    const res = awardRound(rewards, roundAt('bath', `угол ${i}`), { now: at(DAY1) });
    assert.ok(res.awarded, `уборка ${i + 1} должна награждаться`);
    rewards = res.rewards;
  }
  const over = awardRound(rewards, roundAt('bath', 'ещё один угол'), { now: at(DAY1) });
  assert.equal(over.awarded, false);
  assert.equal(over.reason, 'room-limit', 'сработал предохранитель на комнату');
  assert.ok(isRoomExhausted(rewards, 'bath', { now: at(DAY1) }));
  assert.ok(awardRound(rewards, roundAt('kitchen', 'стол'), { now: at(DAY1) }).awarded,
    'другая комната при этом свободна');
});

test('назавтра всё обнуляется, вчерашние числа не копятся', () => {
  let rewards = emptyRewards();
  rewards = awardRound(rewards, roundAt('bath', 'раковина'), { now: at(DAY1) }).rewards;
  rewards = awardRound(rewards, roundAt('bath', 'раковина'), { now: at(DAY1) }).rewards;
  assert.equal(placeCount(rewards, 'bath', 'раковина', at(DAY2)), 0);

  const next = awardRound(rewards, roundAt('bath', 'раковина'), { now: at(DAY2) });
  assert.ok(next.awarded);
  assert.equal(next.rewards.dailyRooms.day, '2026-08-23');
  assert.deepEqual(next.rewards.dailyRooms.places, { 'bath::раковина': 1 }, 'вчерашние места выброшены');
  assert.deepEqual(next.rewards.dailyRooms.rooms, { bath: 1 });
});

test('счётчики переживают нормализацию документа (иначе обнулялись бы при записи)', () => {
  const r = registerCleanup(emptyRewards(), 'bath', 'раковина', { now: at(DAY1) });
  const roundTrip = normalizeRewards(JSON.parse(JSON.stringify(r)));
  assert.equal(placeCount(roundTrip, 'bath', 'раковина', at(DAY1)), 1);
  assert.equal(roomCount(roundTrip, 'bath', at(DAY1)), 1);
  assert.equal(placeCount(normalizeRewards({ dailyRooms: { day: '2026-08-22', places: { 'bath::раковина': 'ерунда' } } }), 'bath', 'раковина', at(DAY1)), 0);
});


// ── Фото награды ────────────────────────────────────────────────────────────
test('у награды может быть фото; эмодзи остаётся запасным', () => {
  const withPic = normalizeRealReward({
    id: 'ice', name: 'Мороженое', cost: 12, emoji: '🍦',
    url: 'https://example/ice.jpg', path: 'families/f1/rewards/ice.jpg', w: 900, h: 675,
  });
  assert.equal(withPic.url, 'https://example/ice.jpg');
  assert.equal(withPic.path, 'families/f1/rewards/ice.jpg');
  assert.deepEqual([withPic.w, withPic.h], [900, 675]);
  assert.equal(withPic.emoji, '🍦', 'эмодзи нужен, пока картинка грузится');

  const noPic = normalizeRealReward({ id: 'kino', name: 'Кино', cost: 30 });
  assert.equal(noPic.url, null, 'нет фото — не выдумываем пустую строку');
  assert.equal(noPic.emoji, '🎁');
  // Мусор в поле ссылки не должен превращаться в битую картинку.
  assert.equal(normalizeRealReward({ id: 'x', name: 'X', cost: 1, url: '   ' }).url, null);
});

test('покупка уносит фото с собой — родитель видит в очереди то же, что ребёнок', () => {
  const item = { id: 'ice', name: 'Мороженое', cost: 5, emoji: '🍦', url: 'https://example/ice.jpg' };
  const res = buyReward({ ...emptyRewards(), currency: 10 }, item, { now: () => 0, rand: () => 0 });
  assert.equal(res.purchase.url, 'https://example/ice.jpg');
  assert.equal(pendingPurchases(res.rewards)[0].url, 'https://example/ice.jpg');
});
