// Тесты ядра раунда (node --test, без Firebase/DOM/камеры).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUND_ORDER, orderCategories, buildRound, currentStep, isFinished,
  stepItems, stepTask, toggleItem, isItemDone, completeStep, skipStep,
  roundProgress, roundTaskText, finishRound, elapsedMs, formatDuration,
  applyRoundToRewards, sessionFromRound,
} from '../js/round-core.js';
import { ACTION_IDS, SPARKLES, emptyRewards, sanitizeScan } from '../js/family-core.js';

// Сырой ответ сканера: три категории вперемешку, порядок «как увидела модель».
const RAW_SCAN = {
  mode: 'closeup',
  items: [
    { id: 1, label: 'тетрадь', category: 'paper', box: [0.1, 0.1, 0.2, 0.2] },
    { id: 2, label: 'фантик', category: 'trash', box: [0.3, 0.1, 0.4, 0.2] },
    { id: 3, label: 'кружка', category: 'dishes', box: [0.5, 0.1, 0.6, 0.2] },
    { id: 4, label: 'чек', category: 'paper', box: [0.7, 0.1, 0.8, 0.2] },
  ],
};
const fixed = (t = 1000) => () => t;
const round0 = () => buildRound(sanitizeScan(RAW_SCAN), {
  roomId: 'kitchen', roomName: 'Кухня', themeId: 'minion', profileId: 'kid1',
  now: fixed(0), rand: () => 0, // surpriseIn = 2 (min)
});

test('порядок цветов фиксирован и покрывает все категории словаря', () => {
  assert.equal(ROUND_ORDER.length, ACTION_IDS.length);
  assert.deepEqual([...ROUND_ORDER].sort(), [...ACTION_IDS].sort());
  assert.equal(ROUND_ORDER[0], 'trash'); // ранняя быстрая победа
  assert.deepEqual(orderCategories(['paper', 'trash', 'toys']), ['trash', 'toys', 'paper']);
  assert.deepEqual(orderCategories(['paper', 'выдумка']), ['paper', 'выдумка']); // неизвестное — в конец
});

test('раунд — очередь шагов по цветам, а не список предметов (§244)', () => {
  const r = round0();
  assert.deepEqual(r.steps.map(s => s.category), ['trash', 'dishes', 'paper']);
  assert.deepEqual(r.steps.map(s => s.itemIds.length), [1, 1, 2]);
  assert.equal(r.items.length, 4);
  assert.equal(r.index, 0);
  assert.equal(r.sparkles, 0);
  assert.match(r.id, /^sess-/);
});

test('текущий шаг отдаёт экрану цвет, текст, счётчик и только свои предметы', () => {
  const r = round0();
  const task = stepTask(r);
  assert.equal(task.category, 'trash');
  assert.equal(task.color, '#8B5CF6');
  assert.equal(task.instruction, 'Выброси мусор');
  assert.equal(task.target, 'Ведро');
  assert.equal(task.total, 1);
  assert.equal(task.done, 0);
  assert.equal(task.allChecked, false);
  assert.equal(task.number, 1);
  assert.equal(task.of, 3);
  assert.deepEqual(task.labels, ['фантик']);
  assert.deepEqual(stepItems(r).map(i => i.id), [2]); // подсвечивается один цвет
});

test('тап по предмету отмечает и снимает отметку, счётчик догоняет', () => {
  let r = round0();
  r = completeStep(r, { now: fixed(1), rand: () => 0 }); // → шаг «посуда»
  r = completeStep(r, { now: fixed(2), rand: () => 0 }); // → шаг «бумаги» (2 предмета)
  assert.equal(stepTask(r).total, 2);
  r = toggleItem(r, 1);
  assert.ok(isItemDone(r, 1));
  assert.equal(stepTask(r).done, 1);
  assert.equal(stepTask(r).allChecked, false);
  r = toggleItem(r, 4);
  assert.equal(stepTask(r).allChecked, true);
  r = toggleItem(r, 4); // передумал
  assert.equal(stepTask(r).done, 1);
});

test('«Готово» закрывает шаг, начисляет искорки и закрывает все его предметы', () => {
  const r = round0();
  const r1 = completeStep(r, { now: fixed(10), rand: () => 0 });
  assert.equal(r1.index, 1);
  assert.equal(r1.sparkles, SPARKLES.step);
  assert.deepEqual(r1.doneItemIds, [2]);
  assert.equal(r1.steps[0].doneAt, new Date(10).toISOString());
  assert.equal(r.index, 0, 'исходный раунд не мутирован');
  assert.equal(r.sparkles, 0);
});

test('«Тут ничего нет» закрывает шаг без начисления (штрафов нет, §336)', () => {
  const r = skipStep(round0(), { now: fixed(5) });
  assert.equal(r.index, 1);
  assert.equal(r.sparkles, 0);
  assert.ok(r.steps[0].skipped);
  assert.deepEqual(r.doneItemIds, []);
});

test('сюрприз выпадает по счётчику закрытых шагов, потом порог заново', () => {
  let r = round0();                       // surpriseIn = 2 при rand()=0
  assert.equal(r.surpriseIn, 2);
  r = completeStep(r, { now: fixed(1), rand: () => 0 });
  assert.equal(r.surpriseNow, false);
  r = completeStep(r, { now: fixed(2), rand: () => 0.99 }); // 2-й шаг → сюрприз
  assert.equal(r.surpriseNow, true);
  assert.equal(r.stepsSinceSurprise, 0);
  assert.equal(r.surpriseIn, 7, 'порог перевыбран из 2..7');
  assert.equal(skipStep(r, { now: fixed(3) }).surpriseNow, false, 'пропуск сюрприза не даёт');
});

test('прогресс и конец раунда', () => {
  let r = round0();
  assert.deepEqual(roundProgress(r), { stepsDone: 0, stepsTotal: 3, itemsDone: 0, itemsTotal: 4, percent: 0 });
  r = completeStep(r, { now: fixed(1), rand: () => 0 });
  assert.equal(roundProgress(r).percent, 33);
  assert.equal(isFinished(r), false);
  r = completeStep(r, { now: fixed(2), rand: () => 0 });
  r = completeStep(r, { now: fixed(3), rand: () => 0 });
  assert.ok(isFinished(r));
  assert.equal(currentStep(r), null);
  assert.equal(stepTask(r), null);
  assert.deepEqual(roundProgress(r), { stepsDone: 3, stepsTotal: 3, itemsDone: 4, itemsTotal: 4, percent: 100 });
  assert.equal(completeStep(r, { now: fixed(4) }).sparkles, r.sparkles, 'после конца не начисляет');
});

test('текст задания для /verify собирается из закрытых шагов, без пропущенных', () => {
  let r = round0();
  r = completeStep(r, { now: fixed(1), rand: () => 0 });   // мусор
  r = skipStep(r, { now: fixed(2) });                       // посуду пропустил
  r = completeStep(r, { now: fixed(3), rand: () => 0 });   // бумаги
  assert.equal(roundTaskText(r), 'Выброси мусор; Собери все бумаги в одну стопку');
  assert.equal(roundTaskText(round0()), 'убрать поверхность');
});

test('проверка «после»: done даёт бонус за комнату, retake — нет', () => {
  let r = round0();
  r = completeStep(r, { now: fixed(1), rand: () => 0 });
  const ok = finishRound(r, { done: true, status: 'done', score: 'great', praise: 'Чисто!', missed: [] }, { now: fixed(60_000) });
  assert.equal(ok.sparkles, SPARKLES.step + SPARKLES.room);
  assert.equal(ok.finishedAt, new Date(60_000).toISOString());
  const no = finishRound(r, { done: false, status: 'retake', missed: [] }, { now: fixed(60_000) });
  assert.equal(no.sparkles, SPARKLES.step);
});

test('таймер: идёт от старта, замирает на финише', () => {
  const r = round0();
  assert.equal(elapsedMs(r, fixed(90_000)), 90_000);
  const done = finishRound(r, { done: true }, { now: fixed(45_000) });
  assert.equal(elapsedMs(done, fixed(999_000)), 45_000);
  assert.equal(formatDuration(45_000), '0:45');
  assert.equal(formatDuration(605_000), '10:05');
  assert.equal(formatDuration(-5), '0:00');
});

test('начисление на ребёнка: валюта всегда, счётчик уборок — только за подтверждённую', () => {
  let r = round0();
  r = completeStep(r, { now: fixed(1), rand: () => 0 });
  const rewards = emptyRewards();
  const notFinished = applyRoundToRewards(rewards, r);
  assert.equal(notFinished.currency, SPARKLES.step);
  assert.equal(notFinished.cleanupsTotal, 0);
  const done = applyRoundToRewards(rewards, finishRound(r, { done: true }, { now: fixed(2) }));
  assert.equal(done.currency, SPARKLES.step + SPARKLES.room);
  assert.equal(done.cleanupsTotal, 1);
  assert.equal(rewards.currency, 0, 'вход не мутирован');
  const retake = applyRoundToRewards(rewards, finishRound(r, { done: false, status: 'retake' }, { now: fixed(2) }));
  assert.equal(retake.cleanupsTotal, 0);
});

test('документ прогресса — только факты, без кадров (§420)', () => {
  let r = round0();
  r = completeStep(r, { now: fixed(1), rand: () => 0 });
  r = skipStep(r, { now: fixed(2) });
  r = completeStep(r, { now: fixed(3), rand: () => 0 });
  const s = sessionFromRound(finishRound(r, { done: true, status: 'done', score: 'good', praise: 'Ок', missed: [] }, { now: fixed(30_000) }));
  assert.equal(s.roomName, 'Кухня');
  assert.equal(s.profileId, 'kid1');
  assert.equal(s.itemsTotal, 4);
  assert.equal(s.durationMs, 30_000);
  assert.deepEqual(s.steps.map(x => [x.category, x.total, x.skipped]), [['trash', 1, false], ['dishes', 1, true], ['paper', 2, false]]);
  assert.equal(s.verify.done, true);
  assert.equal(JSON.stringify(s).includes('box'), false, 'координаты и кадры наружу не уходят');
});

test('пустой скан — раунд без шагов, сразу «чисто»', () => {
  const r = buildRound(sanitizeScan({ mode: 'closeup', items: [] }), { now: fixed(0), rand: () => 0 });
  assert.equal(r.steps.length, 0);
  assert.ok(isFinished(r));
  assert.equal(roundProgress(r).percent, 0);
  assert.equal(applyRoundToRewards(emptyRewards(), r).currency, 0);
});
