// Тесты реальных наград и дневного лимита (node --test, без Firebase/DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRealReward, normalizeShop, makeRewardId, canAfford, buyReward,
  purchases, pendingPurchases, givenPurchases, markGiven, shopView,
} from '../js/shop-core.js';
import {
  ROOM_DAILY_LIMIT, dayKey, roomKey, roomCount, roomsLeft, isRoomExhausted,
  registerRoomCleanup, awardRound,
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

// ── Дневной лимит по комнате ────────────────────────────────────────────────
const roundIn = (roomId) => {
  let r = buildRound(sanitizeScan({ mode: 'closeup', items: [{ id: 1, label: 'чек', category: 'paper', box: [0, 0, 0.1, 0.1] }] }),
    { roomId, roomName: roomId, now: at(0), rand: () => 0 });
  r = completeStep(r, { now: at(1), rand: () => 0 });
  return finishRound(r, { done: true }, { now: at(2) });
};
const DAY1 = Date.parse('2026-08-22T10:00:00');
const DAY1_LATE = Date.parse('2026-08-22T21:00:00');
const DAY2 = Date.parse('2026-08-23T09:00:00');
const REWARD_PER_ROUND = SPARKLES.step + SPARKLES.room; // 1 шаг + комната

test('день — локальный, ключ комнаты не теряется без карты дома', () => {
  assert.equal(dayKey(Date.parse('2026-08-22T10:00:00')), '2026-08-22');
  assert.equal(roomKey(null), '__no_room', 'уборка без комнаты тоже считается — иначе лимит обходится');
  assert.equal(roomKey('maya'), 'maya');
});

test('две уборки комнаты в день награждаются, третья — нет', () => {
  let rewards = emptyRewards();
  const first = awardRound(rewards, roundIn('maya'), { now: at(DAY1) });
  assert.ok(first.awarded);
  assert.equal(first.rewards.currency, REWARD_PER_ROUND);
  assert.equal(first.count, 1);

  const second = awardRound(first.rewards, roundIn('maya'), { now: at(DAY1) });
  assert.ok(second.awarded);
  assert.equal(second.rewards.currency, REWARD_PER_ROUND * 2);
  assert.equal(second.rewards.cleanupsTotal, 2);

  const third = awardRound(second.rewards, roundIn('maya'), { now: at(DAY1_LATE) });
  assert.equal(third.awarded, false);
  assert.equal(third.reason, 'room-limit');
  assert.equal(third.rewards.currency, REWARD_PER_ROUND * 2, 'искорки не начислены');
  assert.equal(third.rewards.earnedTotal, REWARD_PER_ROUND * 2, 'и в заработанное не ушли');
  assert.equal(third.rewards.cleanupsTotal, 2, 'счётчик уборок не накручен');
  assert.equal(third.limit, ROOM_DAILY_LIMIT);
});

test('лимит на комнату, а не на приложение: похожий стол в другой комнате не заблокирован', () => {
  let rewards = emptyRewards();
  rewards = awardRound(rewards, roundIn('maya'), { now: at(DAY1) }).rewards;
  rewards = awardRound(rewards, roundIn('maya'), { now: at(DAY1) }).rewards;
  assert.ok(isRoomExhausted(rewards, 'maya', { now: at(DAY1) }));

  const kitchen = awardRound(rewards, roundIn('kitchen'), { now: at(DAY1) });
  assert.ok(kitchen.awarded, 'кухня со своим столом — своя квота');
  assert.equal(kitchen.rewards.currency, REWARD_PER_ROUND * 3);
  assert.equal(roomsLeft(kitchen.rewards, 'kitchen', { now: at(DAY1) }), 1);
  assert.equal(roomsLeft(kitchen.rewards, 'maya', { now: at(DAY1) }), 0);
});

test('назавтра квота обнуляется, вчерашние числа не копятся в документе', () => {
  let rewards = emptyRewards();
  rewards = awardRound(rewards, roundIn('maya'), { now: at(DAY1) }).rewards;
  rewards = awardRound(rewards, roundIn('maya'), { now: at(DAY1) }).rewards;
  assert.equal(roomCount(rewards, 'maya', at(DAY2)), 0, 'новый день — счёт с нуля');

  const next = awardRound(rewards, roundIn('maya'), { now: at(DAY2) });
  assert.ok(next.awarded);
  assert.equal(next.rewards.dailyRooms.day, '2026-08-23');
  assert.deepEqual(next.rewards.dailyRooms.rooms, { maya: 1 }, 'вчерашние комнаты выброшены целиком');
});

test('счётчик лимита переживает нормализацию документа (иначе обнулялся бы при каждой записи)', () => {
  const r = registerRoomCleanup(emptyRewards(), 'maya', { now: at(DAY1) });
  const roundTrip = normalizeRewards(JSON.parse(JSON.stringify(r)));
  assert.equal(roomCount(roundTrip, 'maya', at(DAY1)), 1);
  assert.equal(roomCount(normalizeRewards({ dailyRooms: { day: '2026-08-22', rooms: { maya: 'ерунда' } } }), 'maya', at(DAY1)), 0);
});
