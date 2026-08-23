// Тесты бонусных заданий (node --test, без Firebase/DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BONUS_TASKS, BONUS_DAILY_LIMIT, bonusTask, bonusesForRoom, bonusesForContext,
  bonusFitsContext, bonusContext,
  bonusesDoneToday, bonusTotalToday, bonusesLeftToday, pickBonus, awardBonus,
} from '../js/bonus-core.js';
import { emptyRewards, normalizeRewards, sanitizeBonus, rankForCleanups } from '../js/family-core.js';

const at = (t) => () => t;
const DAY1 = Date.parse('2026-08-22T10:00:00');
const DAY2 = Date.parse('2026-08-23T09:00:00');

test('каталог заданий: у каждого есть цена, подсказка и что должно быть на фото', () => {
  assert.ok(BONUS_TASKS.length >= 4);
  for (const t of BONUS_TASKS) {
    assert.match(t.id, /^[a-z_]+$/);
    assert.ok(t.sparkles >= 1 && t.sparkles <= 5, `${t.id}: цена бонуса скромная`);
    assert.ok(t.title && t.hint && t.check, `${t.id}: заполнен`);
    assert.ok(t.needs?.cleaned?.length || t.needs?.seen?.length,
      `${t.id}: у задания есть условие — бонус «просто так» предлагаться не должен`);
    assert.ok(t.hint.length > 10, `${t.id}: подсказка объясняет, что снимать`);
  }
  assert.equal(new Set(BONUS_TASKS.map(t => t.id)).size, BONUS_TASKS.length, 'id не повторяются');
  assert.equal(bonusTask('dust').sparkles, 3, 'вытереть пыль — три искорки');
  assert.equal(bonusTask('нет такого'), null);
});

test('справочник по комнате: в ванной сначала зеркало, общие — следом', () => {
  const bath = bonusesForRoom('bathroom').map(t => t.id);
  assert.equal(bath[0], 'mirror', 'специфичное для комнаты — первым');
  assert.ok(bath.includes('dust'), 'общие задания доступны везде');
  assert.ok(!bonusesForRoom('kitchen').some(t => t.id === 'mirror'), 'зеркало из ванной на кухню не лезет');
  assert.ok(bonusesForRoom(undefined).length >= 3, 'без типа комнаты остаются общие');
});

const BATH = { roomType: 'bathroom', cleaned: ['surface'], seen: ['mirror'] };

test('бонус предлагается, пока не исчерпан дневной лимит', () => {
  let rewards = emptyRewards();
  assert.equal(bonusesLeftToday(rewards, { now: at(DAY1) }), BONUS_DAILY_LIMIT);
  const first = pickBonus(rewards, BATH, { now: at(DAY1), rand: () => 0 });
  assert.equal(first.id, 'mirror');

  rewards = awardBonus(rewards, first, { now: at(DAY1) }).rewards;
  const second = pickBonus(rewards, BATH, { now: at(DAY1), rand: () => 0 });
  assert.notEqual(second.id, 'mirror', 'одно и то же задание за день не повторяется');

  rewards = awardBonus(rewards, second, { now: at(DAY1) }).rewards;
  assert.equal(bonusesLeftToday(rewards, { now: at(DAY1) }), 0);
  assert.equal(pickBonus(rewards, BATH, { now: at(DAY1), rand: () => 0 }), null,
    'лимит исчерпан — ничего не предлагаем, чтобы бонус не заменил уборку');
});

// ── Контекст: задание продолжает то, что ребёнок только что делал ───────────
test('тряпочка — после уборки стола, веник — после пола', () => {
  const ids = (ctx) => bonusesForContext(ctx).map(t => t.id);
  assert.deepEqual(ids({ roomType: 'bedroom_child', cleaned: ['surface'] }), ['dust'],
    'протирать имеет смысл то, что только что разобрали');
  assert.deepEqual(ids({ roomType: 'bedroom_child', cleaned: ['floor'] }), ['sweep'],
    'после пола — подмести, а не «протри стол тряпочкой»');
  assert.deepEqual(ids({ roomType: 'bedroom_child', cleaned: ['textile'] }), ['laundry']);
  assert.deepEqual(ids({ roomType: 'bedroom_child', cleaned: [] }), [],
    'ничего не убрали — предлагать нечего');
});

test('«полей цветок» — только если цветок в кадре', () => {
  const ids = (ctx) => bonusesForContext(ctx).map(t => t.id);
  assert.ok(!ids({ roomType: 'bedroom_child', cleaned: ['surface'] }).includes('plants'),
    'цветка не видно — лейку не просим');
  assert.ok(ids({ roomType: 'bedroom_child', cleaned: ['surface'], seen: ['plant'] }).includes('plants'));
  // Зеркало и обувь — и по комнате, и по кадру.
  assert.deepEqual(ids({ roomType: 'bathroom', cleaned: ['surface'], seen: ['mirror'] }), ['mirror', 'dust']);
  assert.deepEqual(ids({ roomType: 'bathroom', cleaned: ['surface'] }), ['dust'],
    'зеркала в кадре нет — остаётся общее задание');
  assert.deepEqual(ids({ roomType: 'kitchen', cleaned: ['surface'], seen: ['mirror'] }), ['dust'],
    'зеркало из ванной на кухню не лезет');
  assert.ok(!ids({ roomType: 'hall', cleaned: ['floor'], seen: [] }).includes('shoes'));
  assert.ok(ids({ roomType: 'hall', cleaned: ['floor'], seen: ['shoes'] }).includes('shoes'));
});

test('стол, протёртый шагом маршрута, второй раз тряпочкой не просят', () => {
  const ids = (ctx) => bonusesForContext(ctx).map(t => t.id);
  assert.deepEqual(ids({ roomType: 'living', cleaned: ['surface', 'wiped'] }), [],
    'ребёнок только что это и сделал — повтор выглядит как «ты не справился»');
  assert.deepEqual(ids({ roomType: 'living', cleaned: ['surface', 'wiped'], seen: ['books'] }), ['books']);
});

test('контекст нормализуется: выдуманные метки не проходят', () => {
  const c = bonusContext({ roomType: 'hall', seen: ['plant', 'ufo'], cleaned: ['floor', 'ufo', 'floor'] });
  assert.deepEqual(c.seen, ['plant']);
  assert.deepEqual(c.cleaned, ['floor']);
  assert.deepEqual(bonusContext(null), { roomType: null, seen: [], cleaned: [] });
  assert.equal(bonusFitsContext(bonusTask('plants'), { seen: ['plant'] }), true);
  assert.equal(bonusFitsContext(bonusTask('plants'), { seen: [] }), false);
  // Строку принимаем как тип комнаты — но без контекста уборки предлагать нечего.
  assert.equal(pickBonus(emptyRewards(), 'bathroom', { now: at(DAY1), rand: () => 0 }), null);
});

test('начисление: растит баланс и заработанное, но не счётчик уборок', () => {
  const start = { ...emptyRewards(), currency: 10, earnedTotal: 40, cleanupsTotal: 8 };
  const res = awardBonus(start, bonusTask('dust'), { now: at(DAY1) });
  assert.ok(res.awarded);
  assert.equal(res.sparkles, 3);
  assert.equal(res.rewards.currency, 13);
  assert.equal(res.rewards.earnedTotal, 43);
  assert.equal(res.rewards.cleanupsTotal, 8, 'бонус — не уборка');
  assert.equal(rankForCleanups(res.rewards.cleanupsTotal), rankForCleanups(8), 'ранг от бонуса не прыгает');
  assert.equal(start.currency, 10, 'вход не мутирован');
});

test('дважды за одно задание и сверх лимита не начисляем', () => {
  let rewards = awardBonus(emptyRewards(), bonusTask('dust'), { now: at(DAY1) }).rewards;
  const again = awardBonus(rewards, bonusTask('dust'), { now: at(DAY1) });
  assert.equal(again.awarded, false);
  assert.equal(again.reason, 'already-done');
  assert.equal(again.rewards.currency, 3, 'искорки не удвоились');

  rewards = awardBonus(rewards, bonusTask('sweep'), { now: at(DAY1) }).rewards;
  const over = awardBonus(rewards, bonusTask('plants'), { now: at(DAY1) });
  assert.equal(over.awarded, false);
  assert.equal(over.reason, 'bonus-limit');
  assert.equal(awardBonus(rewards, { id: 'выдумка' }, { now: at(DAY1) }).reason, 'unknown-task');
});

test('назавтра бонусы снова доступны, вчерашние не копятся', () => {
  let rewards = awardBonus(emptyRewards(), bonusTask('dust'), { now: at(DAY1) }).rewards;
  rewards = awardBonus(rewards, bonusTask('sweep'), { now: at(DAY1) }).rewards;
  assert.equal(bonusTotalToday(rewards, at(DAY1)), 2);
  assert.equal(bonusTotalToday(rewards, at(DAY2)), 0);
  assert.deepEqual(bonusesDoneToday(rewards, at(DAY2)), []);

  const next = awardBonus(rewards, bonusTask('dust'), { now: at(DAY2) });
  assert.ok(next.awarded, 'вчерашнее задание сегодня снова можно');
  assert.deepEqual(next.rewards.dailyBonus, { day: '2026-08-23', ids: { dust: 1 }, total: 1 });
});

test('счётчик бонусов переживает нормализацию документа', () => {
  const r = awardBonus(emptyRewards(), bonusTask('dust'), { now: at(DAY1) }).rewards;
  const roundTrip = normalizeRewards(JSON.parse(JSON.stringify(r)));
  assert.deepEqual(bonusesDoneToday(roundTrip, at(DAY1)), ['dust']);
  assert.equal(normalizeRewards({ dailyBonus: { day: '2026-08-22', ids: { dust: 'ерунда' }, total: -5 } }).dailyBonus.total, 0);
});

test('разбор ответа проверки бонуса: человек в кадре ошибкой не считается', () => {
  const ok = sanitizeBonus({ done: true, praise: 'Пыли как не бывало!', person_detected: true });
  assert.equal(ok.done, true, 'рука ребёнка в кадре — это и есть доказательство');
  assert.equal(ok.praise, 'Пыли как не бывало!');
  assert.equal(ok.hint, '', 'засчитали — подсказка не нужна');

  const no = sanitizeBonus({ done: false, hint: 'Сфоткай тряпку прямо на столе' });
  assert.equal(no.done, false);
  assert.equal(no.hint, 'Сфоткай тряпку прямо на столе');
  assert.deepEqual(sanitizeBonus(null), { done: false, praise: '', hint: '' });
});
