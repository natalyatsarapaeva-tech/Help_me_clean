// Тесты ядра раунда (node --test, без Firebase/DOM/камеры).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUND_ORDER, LAST_CATEGORIES, isLastCategory, orderCategories, buildRound, currentStep, isFinished,
  stepItems, stepTask, toggleItem, isItemDone, completeStep, skipStep,
  roundProgress, roundTaskText, finishRound, elapsedMs, formatDuration,
  applyRoundToRewards, sessionFromRound,
  ZONE_ORDER, zoneOrderIndex, zoneMarkers, roundBrief, currentZone, needsCloseup,
  startCloseup, finishCloseup, cancelCloseup, isCloseupOpen, totalSparkles, activeRound,
  dropItem, isItemDropped, isStepEmpty, roundContextTags,
} from '../js/round-core.js';
import { ACTION_IDS, SPARKLES, ZONE_IDS, emptyRewards, sanitizeScan } from '../js/family-core.js';

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
  assert.ok(ROUND_ORDER.includes('textile') && !ROUND_ORDER.includes('clothes'));
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

// ── Режим B, старый формат ответа: маршрут по точкам ────────────────────────
// Модель иногда сваливается обратно в него. Терять из-за этого весь скан нельзя:
// каждая точка становится очагом вида «ещё», и раунд работает как раньше.
const RAW_ROUTE = {
  mode: 'overview',
  route: [
    { step: 1, label: 'синий грузовик', point: [0.22, 0.71], action: 'в ящик с игрушками', category: 'toys' },
    { step: 2, label: 'мишка', point: [0.40, 0.62], action: 'в ящик с игрушками', category: 'toys' },
    { step: 3, label: 'носки', point: [0.70, 0.80], action: 'в корзину', category: 'textile' },
  ],
  estimated_minutes: 6,
};
const route0 = () => buildRound(sanitizeScan(RAW_ROUTE), {
  roomId: 'maya', roomName: 'Комната Майи', themeId: 'jedi', profileId: 'kid1',
  now: fixed(0), rand: () => 0,
});

test('старый формат (route по точкам) ещё читается: точка = очаг «ещё»', () => {
  const r = route0();
  assert.equal(r.mode, 'overview');
  assert.equal(r.estimatedMinutes, 6);
  assert.equal(r.steps.length, 3, 'три точки — три шага, а не два цвета');
  assert.deepEqual(r.steps.map(s => s.itemIds), [[1], [2], [3]]);
  assert.deepEqual(r.steps.map(s => s.category), ['toys', 'toys', 'textile'],
    'все точки одного вида — порядок модели внутри вида сохраняется');
  assert.equal(r.items[0].point.length, 2);
  assert.equal(r.items[0].box, undefined, 'у точек нет рамок');
});

test('задание очага: своё действие модели важнее общего текста категории', () => {
  const t = stepTask(route0());
  assert.equal(t.mode, 'overview');
  assert.equal(t.title, 'синий грузовик');
  assert.equal(t.instruction, 'в ящик с игрушками'); // не «Игрушки в свой ящик»
  assert.equal(t.target, 'Ящик');
  assert.deepEqual(t.point, [0.22, 0.71]);
  assert.equal(t.total, 1);
  assert.equal(t.of, 3);
});

test('обход: шаги закрываются по одному, искорка за каждый', () => {
  let r = route0();
  r = completeStep(r, { now: fixed(1), rand: () => 0 });
  assert.equal(stepTask(r).title, 'мишка');
  assert.equal(r.sparkles, SPARKLES.step);
  r = completeStep(r, { now: fixed(2), rand: () => 0 });
  r = completeStep(r, { now: fixed(3), rand: () => 0 });
  assert.ok(isFinished(r));
  assert.equal(roundProgress(r).itemsDone, 3);
  assert.equal(applyRoundToRewards(emptyRewards(), finishRound(r, { done: true }, { now: fixed(4) })).currency,
    3 * SPARKLES.step + 5);
});

test('текст для /verify в обходе не повторяет одну категорию десять раз', () => {
  let r = route0();
  r = completeStep(r, { now: fixed(1), rand: () => 0 });
  r = completeStep(r, { now: fixed(2), rand: () => 0 }); // обе игрушки
  r = completeStep(r, { now: fixed(3), rand: () => 0 }); // носки
  // Для /verify берём формулировку очага, а не общий текст категории: она точнее.
  assert.equal(roundTaskText(r), 'в ящик с игрушками; в корзину');
  assert.equal(roundTaskText(route0()), 'убрать комнату');
});

test('в прогресс пишется режим — иначе история A и B неразличима', () => {
  const s = sessionFromRound(finishRound(route0(), { done: true }, { now: fixed(10) }));
  assert.equal(s.mode, 'overview');
  assert.equal(s.itemsTotal, 3);
  assert.equal(JSON.stringify(s).includes('0.22'), false, 'координаты точек наружу не уходят');
  assert.equal(sessionFromRound(round0()).mode, 'closeup');
});

test('место из скана едет в раунд и в прогресс — по нему считается дневной лимит', () => {
  const r = buildRound(sanitizeScan({
    mode: 'closeup', place: '«Раковина»',
    items: [{ id: 1, label: 'тюбик', category: 'trash', box: [0, 0, 0.1, 0.1] }],
  }), { roomId: 'bath', roomName: 'Ванная', now: fixed(0), rand: () => 0 });
  assert.equal(r.place, 'раковина');
  assert.equal(sessionFromRound(r).place, 'раковина');
  const noPlace = buildRound(sanitizeScan({ mode: 'closeup', items: [] }), { now: fixed(0), rand: () => 0 });
  assert.equal(noPlace.place, '', 'сканер не назвал место — не выдумываем');
});

test('полная урна — всегда последний шаг, даже если сканер назвал её первой', () => {
  const r = buildRound(sanitizeScan({ mode: 'closeup', items: [
    { id: 1, label: 'урна с бумагами', category: 'bin_full', box: [0, 0, 0.2, 0.3] },
    { id: 2, label: 'коробка', category: 'floor', box: [0.3, 0.5, 0.5, 0.8] },
    { id: 3, label: 'фантик', category: 'trash', box: [0.6, 0.1, 0.7, 0.2] },
  ] }), { now: fixed(0), rand: () => 0 });
  assert.deepEqual(r.steps.map(s => s.category), ['trash', 'floor', 'bin_full'],
    'мусор собрали, пол освободили — и только потом выносим урну');
  assert.ok(isLastCategory('bin_full') && !isLastCategory('trash'));
  assert.deepEqual(LAST_CATEGORIES, ['bin_full']);
});

test('в обходе комнаты урна уезжает в конец и в старом формате тоже', () => {
  const r = buildRound(sanitizeScan({ mode: 'overview', route: [
    { step: 1, label: 'урна', point: [0.1, 0.9], action: 'вынести', category: 'bin_full' },
    { step: 2, label: 'мишка', point: [0.4, 0.6], action: 'в ящик', category: 'toys' },
    { step: 3, label: 'провод', point: [0.7, 0.8], action: 'смотать', category: 'floor' },
    { step: 4, label: 'кровать', point: [0.5, 0.4], action: 'заправить', category: 'make_bed' },
  ] }), { now: fixed(0), rand: () => 0 });
  assert.deepEqual(r.steps.map(s => s.category), ['toys', 'floor', 'make_bed', 'bin_full']);
});

test('порядок раунда покрывает весь словарь и заканчивается урной', () => {
  assert.equal(ROUND_ORDER.length, ACTION_IDS.length);
  assert.deepEqual([...ROUND_ORDER].sort(), [...ACTION_IDS].sort());
  assert.equal(ROUND_ORDER[ROUND_ORDER.length - 1], 'bin_full');
  assert.ok(ROUND_ORDER.indexOf('floor') < ROUND_ORDER.indexOf('belongs_elsewhere'));
});


// ── Режим B: очаги комнаты, план обхода и крупный план (§268) ───────────────
// Комната раскладывается не на вещи, а на ОЧАГИ: стул с одеждой, пол, стол,
// урна. Порядок наш и повторяет то, как убирается человек, а очаг, который
// видно, но не разглядеть, просит подойти и снять крупным планом.
const RAW_ROOM = {
  mode: 'overview',
  place: 'детская',
  estimated_minutes: 12,
  zones: [
    { id: 1, kind: 'bin', label: 'полная урна', point: [0.9, 0.85], category: 'bin_full', action: 'вынеси мусор', items_estimate: 1 },
    { id: 2, kind: 'desk', label: 'письменный стол', point: [0.6, 0.4], category: 'paper', action: 'наведи порядок на столе', items_estimate: 9 },
    { id: 3, kind: 'floor', label: 'коробки на полу', point: [0.35, 0.9], category: 'floor', action: 'отнеси коробки в шкаф', items_estimate: 3 },
    { id: 4, kind: 'chair', label: 'одежда на стуле', point: [0.2, 0.55], category: 'textile', action: 'убери одежду со стула', items_estimate: 4 },
  ],
};
const room0 = () => buildRound(sanitizeScan(RAW_ROOM), {
  roomId: 'maya', roomName: 'Комната Майи', themeId: 'jedi', profileId: 'kid1',
  now: fixed(0), rand: () => 0,
});

test('план обхода наш: стул → пол → стол → протереть → мусор', () => {
  const r = room0();
  assert.deepEqual(r.items.map(z => z.kind), ['chair', 'floor', 'desk', 'wipe', 'bin'],
    'сначала быстрое и крупное, мелкая разборка стола позже, урна последней');
  assert.equal(r.steps.length, 5);
  assert.equal(r.estimatedMinutes, 12);
  assert.equal(r.place, 'детская');
  assert.ok(zoneOrderIndex('chair') < zoneOrderIndex('desk'));
  assert.ok(zoneOrderIndex('wipe') < zoneOrderIndex('bin'), 'протирают до выноса мусора');
  assert.deepEqual([...ZONE_ORDER].sort(), [...ZONE_IDS].sort(), 'порядок покрывает весь словарь очагов');
});

test('«протереть» добавляем сами: модель пыль на фото не видит', () => {
  const r = room0();
  const wipe = r.items.find(z => z.kind === 'wipe');
  assert.equal(wipe.label, 'письменный стол');
  assert.equal(wipe.action, 'протри письменный стол');
  assert.deepEqual(wipe.point, [0.6, 0.4], 'метка та же, что у самой поверхности');
  // Без поверхностей протирать нечего — лишнего шага не выдумываем.
  const bare = buildRound(sanitizeScan({ mode: 'overview', zones: [
    { id: 1, kind: 'chair', label: 'стул', point: [0.2, 0.5], category: 'textile' },
  ] }), { now: fixed(0), rand: () => 0 });
  assert.deepEqual(bare.items.map(z => z.kind), ['chair']);
  // И не больше двух за раунд: три протирания — уже наказание.
  const many = buildRound(sanitizeScan({ mode: 'overview', zones: [
    { id: 1, kind: 'desk', label: 'стол', point: [0.1, 0.1], category: 'paper' },
    { id: 2, kind: 'shelf', label: 'полка', point: [0.2, 0.2], category: 'paper' },
    { id: 3, kind: 'surface', label: 'подоконник', point: [0.3, 0.3], category: 'paper' },
  ] }), { now: fixed(0), rand: () => 0 });
  assert.equal(many.items.filter(z => z.kind === 'wipe').length, 2);
});

test('брифинг: сколько очагов, что предстоит и сколько за это будет', () => {
  const b = roundBrief(room0());
  assert.equal(b.zones, 4, '«протереть» отдельным местом не считается');
  assert.equal(b.steps, 5);
  assert.equal(b.minutes, 12);
  assert.equal(b.closeups, 1, 'стол просит крупный план');
  // Обещание намеренно занижено: крупный план стола добавит искорок сверху.
  assert.equal(b.minSparkles, 5 * SPARKLES.step + SPARKLES.room);
  assert.deepEqual(b.plan.map(x => x.text), [
    'убери одежду со стула', 'отнеси коробки в шкаф', 'наведи порядок на столе',
    'протри письменный стол', 'вынеси мусор',
  ]);
  assert.deepEqual(b.plan.map(x => x.no), [1, 2, 3, null, 4], 'номера — те же, что на кадре');
});

test('нумерация меток одна для брифинга и для раунда', () => {
  const m = zoneMarkers(room0());
  assert.deepEqual(m.map(x => x.no), [1, 2, 3, null, 4]);
  assert.equal(m[0].label, 'одежда на стуле');
  assert.equal(m[3].kind, 'wipe', 'протирание метку делит с поверхностью, номера не занимает');
  assert.deepEqual(m[3].point, m[2].point);
});

test('очаг с мелочью просит крупный план, очевидный — нет', () => {
  const r = room0();
  assert.equal(needsCloseup(r), false, 'стул с одеждой и так понятен');
  assert.equal(currentZone(r).kind, 'chair');
  const atDesk = completeStep(completeStep(r, { now: fixed(1) }), { now: fixed(2) });
  assert.equal(currentZone(atDesk).kind, 'desk');
  assert.equal(needsCloseup(atDesk), true);
  assert.equal(stepTask(atDesk).closeup, true);
  // Слово модели весомее умолчания по виду очага.
  const said = buildRound(sanitizeScan({ mode: 'overview', zones: [
    { id: 1, kind: 'desk', label: 'стол', point: [0.5, 0.5], category: 'paper', items_estimate: 9, needs_closeup: false },
  ] }), { now: fixed(0), rand: () => 0 });
  assert.equal(needsCloseup(said), false);
});

test('крупный план внутри очага: искорки уезжают в общий счёт комнаты', () => {
  let r = completeStep(completeStep(room0(), { now: fixed(1) }), { now: fixed(2) }); // стул, пол
  assert.equal(r.sparkles, 2 * SPARKLES.step);
  r = startCloseup(r, sanitizeScan({ mode: 'closeup', place: 'стол у окна', items: [
    { id: 1, label: 'тетрадь', category: 'paper', box: [0.1, 0.1, 0.2, 0.2] },
    { id: 2, label: 'фантик', category: 'trash', box: [0.3, 0.1, 0.4, 0.2] },
  ] }), { now: fixed(3), rand: () => 0 });
  assert.ok(isCloseupOpen(r));
  assert.equal(r.place, 'детская', 'место комнаты крупный план не переписывает: лимит считается по нему');
  assert.equal(stepTask(r).mode, 'closeup', 'внутри очага работает обычный раунд по цветам');
  assert.equal(stepTask(r).inCloseup, true);
  assert.equal(stepTask(r).zoneLabel, 'письменный стол');
  r = completeStep(r, { now: fixed(4), rand: () => 0 });
  assert.equal(totalSparkles(r), 3 * SPARKLES.step, 'искорка за шаг внутри очага видна сразу');
  r = completeStep(r, { now: fixed(5), rand: () => 0 });
  assert.ok(isFinished(r), 'крупный план отработан');
  r = finishCloseup(r, { now: fixed(6), rand: () => 0 });
  assert.equal(isCloseupOpen(r), false);
  // Два шага внутри плюс сам очаг — стол оплачен полностью.
  assert.equal(r.sparkles, 5 * SPARKLES.step);
  assert.equal(currentZone(r).kind, 'wipe', 'после стола — протереть стол');
  assert.equal(r.closeups.length, 1);
  assert.equal(sessionFromRound(r).closeups[0].label, 'письменный стол');
});

test('крупный план не открылся (там уже чисто) — очаг остаётся шагом комнаты', () => {
  const r = completeStep(completeStep(room0(), { now: fixed(1) }), { now: fixed(2) });
  const same = startCloseup(r, sanitizeScan({ mode: 'closeup', items: [] }), { now: fixed(3), rand: () => 0 });
  assert.equal(same.sub, null, 'пустой скан вложенный раунд не открывает');
  assert.equal(currentZone(same).kind, 'desk', 'шаг никуда не делся');
  // «Уберу и так» — тоже возврат к обычному шагу, без потери прогресса.
  const opened = startCloseup(r, sanitizeScan({ mode: 'closeup', items: [
    { id: 1, label: 'ручка', category: 'stationery', box: [0.1, 0.1, 0.2, 0.2] },
  ] }), { now: fixed(3), rand: () => 0 });
  const back = cancelCloseup(opened);
  assert.equal(isCloseupOpen(back), false);
  assert.equal(back.sparkles, r.sparkles);
  assert.equal(currentZone(back).kind, 'desk');
});

test('прогресс считает крупный план вместе с комнатой — полоска не стоит', () => {
  let r = completeStep(room0(), { now: fixed(1) });
  const before = roundProgress(r);
  r = completeStep(r, { now: fixed(2) });
  r = startCloseup(r, sanitizeScan({ mode: 'closeup', items: [
    { id: 1, label: 'тетрадь', category: 'paper', box: [0.1, 0.1, 0.2, 0.2] },
    { id: 2, label: 'фантик', category: 'trash', box: [0.3, 0.1, 0.4, 0.2] },
  ] }), { now: fixed(3), rand: () => 0 });
  const inside = roundProgress(r);
  assert.equal(inside.stepsTotal, 7, '5 очагов + 2 цвета на столе');
  r = completeStep(r, { now: fixed(4), rand: () => 0 });
  assert.ok(roundProgress(r).percent > inside.percent, 'шаг внутри очага двигает полоску');
  assert.ok(inside.percent >= before.percent);
});

// ── «Тут этого нет» — точечно, по одной вещи ────────────────────────────────
test('вычёркивание одной вещи не роняет весь шаг', () => {
  let r = round0(); // бумаги: тетрадь + чек
  assert.equal(stepTask(r).category, 'trash');
  r = completeStep(r, { now: fixed(1), rand: () => 0 }); // мусор
  r = completeStep(r, { now: fixed(2), rand: () => 0 }); // посуда
  assert.equal(stepTask(r).category, 'paper');
  assert.equal(stepTask(r).total, 2);
  r = dropItem(r, 4); // чека на столе нет — сканер придумал
  assert.ok(isItemDropped(r, 4));
  assert.equal(stepTask(r).total, 1, 'тетрадь никуда не делась');
  assert.deepEqual(stepItems(r).map(it => it.id), [1]);
  assert.equal(isStepEmpty(r), false);
  r = completeStep(r, { now: fixed(3), rand: () => 0 });
  assert.equal(r.sparkles, 3 * SPARKLES.step, 'шаг закрыт и оплачен: работа была');
  assert.deepEqual(r.doneItemIds.includes(4), false, 'вычеркнутое убранным не считается');
  assert.equal(sessionFromRound(r).itemsDropped, 1);
});

test('шаг, в котором вычеркнули всё, закрывается без искорки', () => {
  let r = round0();
  r = dropItem(r, 2); // единственный мусор
  assert.equal(isStepEmpty(r), true);
  r = completeStep(r, { now: fixed(1), rand: () => 0 });
  assert.equal(r.sparkles, 0, 'платим за уборку, а не за нажатие «Готово»');
  assert.equal(r.steps[0].skipped, true);
  assert.equal(r.index, 1);
});

test('вычеркнутое снимает отметку «убрал» — иначе шаг оплачивался бы дважды', () => {
  let r = round0();
  r = toggleItem(r, 2);
  assert.ok(isItemDone(r, 2));
  r = dropItem(r, 2);
  assert.equal(isItemDone(r, 2), false);
  assert.equal(activeRound(r).droppedItemIds.length, 1);
});

test('вычёркивание работает и внутри крупного плана', () => {
  let r = completeStep(completeStep(room0(), { now: fixed(1) }), { now: fixed(2) });
  r = startCloseup(r, sanitizeScan({ mode: 'closeup', items: [
    { id: 1, label: 'тетрадь', category: 'paper', box: [0.1, 0.1, 0.2, 0.2] },
    { id: 2, label: 'чек', category: 'paper', box: [0.3, 0.1, 0.4, 0.2] },
  ] }), { now: fixed(3), rand: () => 0 });
  r = dropItem(r, 2);
  assert.equal(r.sub.droppedItemIds.length, 1, 'вычеркнули внутри очага, а не в комнате');
  assert.deepEqual(r.droppedItemIds, []);
  assert.equal(stepTask(r).total, 1);
});


// ── Контекст раунда для бонусных заданий ────────────────────────────────────
test('контекст берётся из ЗАКРЫТЫХ шагов, а не из того, что было в комнате', () => {
  let r = room0(); // стул → пол → стол → протереть → урна
  assert.deepEqual(roundContextTags(r).cleaned, [], 'ничего не закрыто — предлагать нечего');
  r = completeStep(r, { now: fixed(1) });                       // стул с одеждой
  assert.deepEqual(roundContextTags(r).cleaned, ['textile']);
  r = skipStep(r, { now: fixed(2) });                           // пол пропущен
  assert.deepEqual(roundContextTags(r).cleaned, ['textile'],
    'пропущенный шаг в контекст не идёт: ребёнок его не убирал');
  r = completeStep(r, { now: fixed(3) });                       // стол
  assert.ok(roundContextTags(r).cleaned.includes('surface'));
  r = completeStep(r, { now: fixed(4) });                       // протереть
  assert.ok(roundContextTags(r).cleaned.includes('wiped'), 'протёртый стол помечен');
  r = completeStep(r, { now: fixed(5) });                       // урна
  assert.ok(roundContextTags(r).cleaned.includes('trash'));
});

test('на крупном плане закрытый цвет означает разобранную поверхность', () => {
  let r = round0();
  r = completeStep(r, { now: fixed(1) });
  assert.deepEqual(roundContextTags(r).cleaned, ['surface', 'trash'],
    'сняли стол и убрали мусор — и то и другое');
});

test('увиденное сканером едет в раунд, крупный план его дополняет', () => {
  const r = buildRound(sanitizeScan({ mode: 'overview', seen: ['plant', 'ufo'], zones: [
    { id: 1, kind: 'desk', label: 'стол', point: [0.5, 0.5], category: 'paper', items_estimate: 9 },
  ] }), { now: fixed(0), rand: () => 0 });
  assert.deepEqual(roundContextTags(r).seen, ['plant'], 'выдуманные метки отброшены');
  // Цветок на подоконнике видно только вблизи — крупный план его находит.
  const withSub = startCloseup(r, sanitizeScan({ mode: 'closeup', seen: ['books'], items: [
    { id: 1, label: 'тетрадь', category: 'paper', box: [0.1, 0.1, 0.2, 0.2] },
  ] }), { now: fixed(1), rand: () => 0 });
  assert.deepEqual(roundContextTags(withSub).seen.sort(), ['books', 'plant']);
});
