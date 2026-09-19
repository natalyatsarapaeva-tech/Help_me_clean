// Тесты заданий от родителя (node --test, без Firebase/DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TASK_COST, TASK_STATUSES, REPEATS, STREAK_STEPS, STREAK_BONUS,
  makeTaskId, normalizeTask, normalizeTasks, tasksForProfile,
  emptyRun, normalizeRun, runsById, runFor, taskState, isOpen, isWaiting, isDone,
  submitTask, approveTask, returnTask,
  childInbox, inboxCount, reviewQueue, parentTasks,
  normalizeRepeat, isRepeating, periodKey, periodOrdinal, isNextPeriod,
  streakBonus, nextStreakStep, currentRun, streakState,
} from '../js/tasks-core.js';
import { emptyRewards } from '../js/family-core.js';

const at = (t) => () => t;
// Даты — местные: «день» задания это день ребёнка, а не UTC-сутки.
const day = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const task = (over = {}) => ({
  id: 'trash-1', title: 'Вынести мусор', profileId: 'maya', cost: 10,
  createdAt: '2026-09-01T10:00:00.000Z', ...over,
});
const photo = { url: 'https://example/1.jpg', path: 'families/f/tasks/trash-1.jpg', w: 900, h: 600 };

// ── Задание ─────────────────────────────────────────────────────────────────
test('задание без текста, исполнителя или цены — не задание', () => {
  assert.equal(normalizeTask(task({ title: '   ' })), null);
  assert.equal(normalizeTask(task({ profileId: '' })), null, 'некому делать');
  assert.equal(normalizeTask(task({ cost: 0 })), null, 'цену назначает родитель, а не мы');
  assert.equal(normalizeTask(task({ cost: MAX_TASK_COST + 1 })), null, 'это опечатка, а не награда');
  assert.equal(normalizeTask(null), null);
});

test('цена не округляется вверх и не выдумывается', () => {
  assert.equal(normalizeTask(task({ cost: 7 })).cost, 7);
  assert.equal(normalizeTask(task({ cost: '12' })).cost, 12);
});

test('комната необязательна, а её имя копируется в задание', () => {
  const loose = normalizeTask(task({ roomId: null, roomName: '' }));
  assert.equal(loose.roomId, null, '«вынести мусор» не живёт ни в одной комнате');
  const bound = normalizeTask(task({ roomId: 'maya-room', roomName: 'Комната Майи' }));
  assert.equal(bound.roomId, 'maya-room');
  assert.equal(bound.roomName, 'Комната Майи', 'подпись не требует карты дома');
});

test('список — от старых к новым и только свои', () => {
  const list = normalizeTasks([
    task({ id: 'b', createdAt: '2026-09-02T00:00:00Z' }),
    task({ id: 'a', createdAt: '2026-09-01T00:00:00Z' }),
    task({ id: 'c', profileId: 'lev', createdAt: '2026-09-03T00:00:00Z' }),
    { id: 'junk' },
  ]);
  assert.deepEqual(list.map(t => t.id), ['a', 'b', 'c']);
  assert.deepEqual(tasksForProfile(list, 'maya').map(t => t.id), ['a', 'b']);
});

test('id задания читаемый и не повторяется', () => {
  assert.match(makeTaskId('Вынести мусор', () => 0.5), /^task-[a-z0-9]+$/);
  assert.match(makeTaskId('Wash the dishes', () => 0.5), /^wash-the-dishes-/);
  assert.notEqual(makeTaskId('x', () => 0.1), makeTaskId('x', () => 0.9));
});

// ── Ход выполнения ──────────────────────────────────────────────────────────
test('нет документа — задание просто новое', () => {
  assert.equal(taskState(undefined), 'new');
  assert.equal(runFor([], 'trash-1').status, 'new');
  assert.ok(isOpen(emptyRun('trash-1')));
  assert.deepEqual(TASK_STATUSES, ['new', 'sent', 'returned', 'done']);
});

test('мусор в документе не ломает состояние', () => {
  const r = normalizeRun({ status: 'приколись', url: '  ', w: 'x' }, 'trash-1');
  assert.equal(r.status, 'new');
  assert.equal(r.url, null);
  assert.equal(r.w, null);
});

// ── Ребёнок присылает фото ──────────────────────────────────────────────────
test('фото уходит родителю, а не в проверку ИИ', () => {
  const { run, error } = submitTask(emptyRun('trash-1'), photo, { now: at(1000) });
  assert.equal(error, null);
  assert.equal(run.status, 'sent');
  assert.equal(run.url, photo.url);
  assert.equal(run.sentAt, new Date(1000).toISOString());
  assert.ok(isWaiting(run) && !isOpen(run), 'ребёнку тут делать больше нечего');
});

test('без фото отправить нельзя, засчитанное не пересылается', () => {
  assert.equal(submitTask(emptyRun('t'), null).error, 'no-photo');
  const done = normalizeRun({ status: 'done' }, 't');
  assert.equal(submitTask(done, photo).error, 'already-done');
});

test('переснял после возврата — комментарий родителя уходит', () => {
  const returned = returnTask(submitTask(emptyRun('t'), photo, { now: at(1) }).run,
    'Стол вижу, а пол?', { now: at(2) }).run;
  assert.equal(returned.status, 'returned');
  assert.equal(returned.note, 'Стол вижу, а пол?');
  assert.ok(isOpen(returned), 'возврат — это «переделай», а не «нет»');
  const again = submitTask(returned, { ...photo, url: 'https://example/2.jpg' }, { now: at(3) }).run;
  assert.equal(again.status, 'sent');
  assert.equal(again.note, '', 'старое замечание относилось к старому фото');
  assert.equal(again.url, 'https://example/2.jpg');
});

// ── Родитель засчитывает ────────────────────────────────────────────────────
test('засчитано — начисляется ровно назначенная цена', () => {
  const sent = submitTask(emptyRun('trash-1'), photo, { now: at(1) }).run;
  const res = approveTask(emptyRewards(), task({ cost: 10 }), sent, { now: at(2) });
  assert.equal(res.error, null);
  assert.equal(res.awarded, true);
  assert.equal(res.sparkles, 10);
  assert.equal(res.rewards.currency, 10);
  assert.equal(res.rewards.earnedTotal, 10);
  assert.equal(res.run.status, 'done');
  assert.equal(res.run.url, photo.url, 'фото остаётся: видно, за что заплачено');
});

test('задание не поднимает ранг: счётчик уборок не трогается', () => {
  const before = { ...emptyRewards(), cleanupsTotal: 3 };
  const res = approveTask(before, task({ cost: 50 }), emptyRun('trash-1'), { now: at(1) });
  assert.equal(res.rewards.cleanupsTotal, 3, 'ранг растёт за уборку, а не за задания');
});

test('второе «засчитать» не платит второй раз', () => {
  const first = approveTask(emptyRewards(), task(), emptyRun('trash-1'), { now: at(1) });
  const again = approveTask(first.rewards, task(), first.run, { now: at(2) });
  assert.equal(again.error, 'already-done');
  assert.equal(again.awarded, false);
  assert.equal(again.rewards.currency, first.rewards.currency, 'баланс не вырос');
  assert.equal(again.run.decidedAt, first.run.decidedAt, 'решение не переписано');
});

test('засчитать можно и без фото: родитель мог всё видеть сам', () => {
  const res = approveTask(emptyRewards(), task({ cost: 4 }), emptyRun('trash-1'), { now: at(1) });
  assert.equal(res.awarded, true);
  assert.equal(res.rewards.currency, 4);
});

test('неизвестное задание не платит', () => {
  const res = approveTask(emptyRewards(), { id: 'x' }, emptyRun('x'));
  assert.equal(res.error, 'unknown-task');
  assert.equal(res.rewards.currency, 0);
});

test('засчитанное не возвращается на переделку', () => {
  const done = approveTask(emptyRewards(), task(), emptyRun('trash-1'), { now: at(1) }).run;
  const res = returnTask(done, 'переделай');
  assert.equal(res.error, 'already-done');
  assert.equal(res.run.status, 'done', 'искорки уже у ребёнка — отбирать их нечестно');
});

// ── Витрины ─────────────────────────────────────────────────────────────────
test('входящие ребёнка: три полки и сколько на них искорок', () => {
  const tasks = [
    task({ id: 'a', cost: 10 }),
    task({ id: 'b', cost: 5 }),
    task({ id: 'c', cost: 3 }),
    task({ id: 'd', profileId: 'lev', cost: 99 }),
  ];
  const runs = [
    { id: 'b', status: 'sent', url: photo.url, sentAt: '2026-09-02T00:00:00Z' },
    { id: 'c', status: 'done' },
  ];
  const inbox = childInbox(tasks, runs, 'maya');
  assert.deepEqual(inbox.todo.map(r => r.task.id), ['a']);
  assert.deepEqual(inbox.waiting.map(r => r.task.id), ['b']);
  assert.deepEqual(inbox.done.map(r => r.task.id), ['c']);
  assert.equal(inbox.sparklesTodo, 10);
  assert.equal(inbox.sparklesWaiting, 5);
  assert.equal(inboxCount(tasks, runs, 'maya'), 1, 'цифра на кнопке — только то, что делать');
  assert.equal(inboxCount(tasks, runs, 'lev'), 1, 'чужие задания в чужие входящие не попадают');
});

test('очередь проверки — в порядке присылки и по всем детям', () => {
  const tasks = [task({ id: 'a' }), task({ id: 'b', profileId: 'lev' }), task({ id: 'c' })];
  const entries = [
    { profile: { id: 'maya', name: 'Майя' }, runs: [
      { id: 'a', status: 'sent', url: photo.url, sentAt: '2026-09-02T12:00:00Z' },
      { id: 'c', status: 'new' },
    ] },
    { profile: { id: 'lev', name: 'Лев' }, runs: [
      { id: 'b', status: 'sent', url: photo.url, sentAt: '2026-09-02T09:00:00Z' },
    ] },
  ];
  const queue = reviewQueue(tasks, entries);
  assert.deepEqual(queue.map(r => r.task.id), ['b', 'a'], 'кто раньше прислал');
  assert.equal(queue[0].profile.name, 'Лев');
});

test('родитель видит все задания с состоянием, включая висящие', () => {
  const tasks = [task({ id: 'a' }), task({ id: 'b' })];
  const entries = [{ profile: { id: 'maya', name: 'Майя' }, runs: [{ id: 'b', status: 'done' }] }];
  const rows = parentTasks(tasks, entries);
  assert.deepEqual(rows.map(r => [r.task.id, r.state]), [['a', 'new'], ['b', 'done']]);
  assert.equal(rows[0].profile.name, 'Майя');
});

test('удалённый профиль не роняет список родителя', () => {
  const rows = parentTasks([task({ id: 'a', profileId: 'gone' })], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profile, null);
  assert.equal(rows[0].state, 'new');
});

// ── Повтор: периоды ─────────────────────────────────────────────────────────
test('повтор — только из закрытого списка, по умолчанию разовое', () => {
  assert.deepEqual(REPEATS, ['none', 'daily', 'weekly', 'monthly']);
  assert.equal(normalizeTask(task()).repeat, 'none', 'задание не становится повторяющимся само');
  assert.equal(normalizeTask(task({ repeat: 'daily' })).repeat, 'daily');
  assert.equal(normalizeRepeat('каждые 3 дня'), 'none', 'расписание, которого нет, не выдумываем');
  assert.ok(isRepeating('weekly') && !isRepeating('none'));
});

test('ключ периода читаем глазами, а неделя считается с понедельника', () => {
  assert.equal(periodKey('daily', day(2026, 9, 19)), '2026-09-19');
  assert.equal(periodKey('weekly', day(2026, 9, 19)), 'W2026-09-14', 'суббота принадлежит своей неделе');
  assert.equal(periodKey('weekly', day(2026, 9, 14)), 'W2026-09-14');
  assert.equal(periodKey('weekly', day(2026, 9, 20)), 'W2026-09-14', 'воскресенье — ещё та же неделя');
  assert.equal(periodKey('weekly', day(2026, 9, 21)), 'W2026-09-21', 'понедельник открывает новую');
  assert.equal(periodKey('monthly', day(2026, 9, 19)), 'M2026-09');
  assert.equal(periodKey('none', day(2026, 9, 19)), 'once');
});

test('соседние периоды отличаются на единицу, пропуск виден', () => {
  assert.ok(isNextPeriod('daily', '2026-09-18', '2026-09-19'));
  assert.ok(!isNextPeriod('daily', '2026-09-17', '2026-09-19'), 'день пропущен');
  assert.ok(isNextPeriod('daily', '2026-02-28', '2026-03-01'), 'конец месяца не рвёт серию');
  assert.ok(isNextPeriod('weekly', 'W2026-09-14', 'W2026-09-21'));
  assert.ok(isNextPeriod('monthly', 'M2026-12', 'M2027-01'), 'новый год не рвёт серию');
  assert.equal(periodOrdinal('daily', 'W2026-09-14'), null, 'чужой ключ не считается за период');
  assert.ok(!isNextPeriod('weekly', '2026-09-14', 'W2026-09-21'), 'сменили периодичность — серия начнётся заново');
});

// ── Повтор: задание возвращается само ───────────────────────────────────────
test('сделанное вчера ежедневное задание сегодня снова открыто', () => {
  const t = task({ repeat: 'daily' });
  const done = approveTask(emptyRewards(), t, emptyRun(t.id), { now: at(day(2026, 9, 18)) }).run;
  assert.ok(isDone(done));
  const today = currentRun(t, done, { now: at(day(2026, 9, 19)) });
  assert.equal(today.status, 'new', 'мусор выносят не один раз в жизни');
  assert.equal(today.url, null, 'вчерашнее фото к сегодняшнему дню отношения не имеет');
  assert.equal(today.streak, 1, 'серия пережила смену дня');
  assert.equal(today.doneCount, 1);
  assert.ok(isDone(currentRun(t, done, { now: at(day(2026, 9, 18, 23)) })), 'в свой день оно сделано');
});

test('вечернее фото не растворяется вместе со вчерашним днём', () => {
  const t = task({ repeat: 'daily', cost: 10 });
  const sent = submitTask(emptyRun(t.id), photo, { now: at(day(2026, 9, 18, 21)), task: t }).run;
  assert.equal(sent.period, '2026-09-18');
  const entries = [{ profile: { id: 'maya', name: 'Майя' }, runs: [{ id: t.id, ...sent }] }];
  const now = at(day(2026, 9, 19, 8));
  assert.deepEqual(reviewQueue([t], entries, { now }).map(r => r.task.id), [t.id],
    'родитель смотрит утром — работа должна быть в очереди');
  assert.deepEqual(childInbox([t], entries[0].runs, 'maya', { now }).waiting.map(r => r.task.id), [t.id]);

  // Засчитывается ВЧЕРАШНИЙ день: работа сделана тогда, когда её сделал ребёнок.
  const res = approveTask(emptyRewards(), t, currentRun(t, sent, { now }), { now });
  assert.equal(res.awarded, true);
  assert.equal(res.run.lastDonePeriod, '2026-09-18');
  const today = currentRun(t, res.run, { now });
  assert.equal(today.status, 'new', 'сегодняшний день при этом не съеден');
  assert.equal(today.streak, 1, 'вчера засчитано — серия идёт');
});

test('возвращённое на переделку переезжает в новый период с замечанием', () => {
  const t = task({ repeat: 'daily' });
  const sent = submitTask(emptyRun(t.id), photo, { now: at(day(2026, 9, 18, 20)), task: t }).run;
  const back = returnTask(sent, 'Стол вижу, а пол?', { now: at(day(2026, 9, 18, 21)) }).run;
  const today = currentRun(t, back, { now: at(day(2026, 9, 19)) });
  assert.ok(isOpen(today), 'делать всё ещё нужно');
  assert.equal(today.note, 'Стол вижу, а пол?', 'единственное объяснение не стирается сменой суток');
  assert.equal(today.period, '2026-09-19');
});

test('разовое задание не возвращается никогда', () => {
  const done = approveTask(emptyRewards(), task(), emptyRun('trash-1'), { now: at(day(2026, 9, 18)) }).run;
  assert.ok(isDone(currentRun(task(), done, { now: at(day(2027, 1, 1)) })));
});

test('старая запись без периода не воскресает и не залипает', () => {
  const t = task({ repeat: 'daily' });
  // Документ времён, когда повторов ещё не было: периода нет, есть дата решения.
  const legacy = { taskId: t.id, status: 'done', decidedAt: new Date(day(2026, 9, 18)).toISOString() };
  assert.equal(currentRun(t, legacy, { now: at(day(2026, 9, 19)) }).status, 'new');
  assert.equal(currentRun(t, legacy, { now: at(day(2026, 9, 18, 20)) }).status, 'done');
});

test('пропущенный период гасит серию, а рекорд остаётся', () => {
  const t = task({ repeat: 'daily' });
  let run = emptyRun(t.id);
  for (const d of [15, 16, 17]) run = approveTask(emptyRewards(), t, run, { now: at(day(2026, 9, d)) }).run;
  assert.equal(run.streak, 3);
  const later = currentRun(t, run, { now: at(day(2026, 9, 19)) }); // 18-е пропущено
  assert.equal(later.streak, 0, 'показывать «🔥 3» после пропуска — врать ребёнку');
  assert.equal(later.bestStreak, 3, 'рекорд не отбирают (§336)');
  const state = streakState(t, run, { now: at(day(2026, 9, 18)) });
  assert.equal(state.streak, 3);
  assert.ok(state.atRisk, 'сегодня ещё не сделано — самое время сказать «не потеряй»');
});

// ── Повтор: серия и добавка ─────────────────────────────────────────────────
test('ступени серии и добавки за них', () => {
  assert.deepEqual(STREAK_STEPS, [5, 7, 10, 15, 30]);
  for (const step of STREAK_STEPS) assert.equal(streakBonus(step), STREAK_BONUS[step], `ступень ${step}`);
  assert.equal(streakBonus(4), 0, 'добавка платится на ступени, а не каждый раз');
  assert.equal(streakBonus(0), 0);
  assert.equal(streakBonus(35), 0);
  assert.equal(streakBonus(60), STREAK_BONUS[30], 'после месяца привычку тоже есть чем держать');
  assert.deepEqual(nextStreakStep(0), { at: 5, need: 5, bonus: STREAK_BONUS[5] });
  assert.deepEqual(nextStreakStep(5), { at: 7, need: 2, bonus: STREAK_BONUS[7] });
  assert.deepEqual(nextStreakStep(31), { at: 60, need: 29, bonus: STREAK_BONUS[30] });
});

test('пять дней подряд — цена задания плюс добавка за серию', () => {
  const t = task({ repeat: 'daily', cost: 10 });
  let rewards = emptyRewards(), run = emptyRun(t.id), last = null;
  for (let d = 15; d <= 19; d++) {
    last = approveTask(rewards, t, run, { now: at(day(2026, 9, d)) });
    rewards = last.rewards; run = last.run;
  }
  assert.equal(last.streak, 5);
  assert.equal(last.cost, 10);
  assert.equal(last.bonus, STREAK_BONUS[5]);
  assert.equal(last.sparkles, 10 + STREAK_BONUS[5]);
  assert.equal(rewards.currency, 10 * 5 + STREAK_BONUS[5], 'четыре дня по цене, пятый — с добавкой');
  assert.equal(rewards.earnedTotal, rewards.currency);
  assert.equal(rewards.cleanupsTotal, 0, 'ранг растёт за уборку, а не за серию заданий');
});

test('серия рвётся пропуском и начинается заново — но начинается', () => {
  const t = task({ repeat: 'daily', cost: 3 });
  let rewards = emptyRewards(), run = emptyRun(t.id);
  for (const d of [15, 16, 17]) {
    const res = approveTask(rewards, t, run, { now: at(day(2026, 9, d)) });
    rewards = res.rewards; run = res.run;
  }
  const after = approveTask(rewards, t, run, { now: at(day(2026, 9, 19)) });
  assert.equal(after.streak, 1, 'пропустил — считаем сначала');
  assert.equal(after.bonus, 0);
  assert.equal(after.sparkles, 3, 'но работа всё равно оплачена');
  assert.equal(after.run.bestStreak, 3);
});

test('у еженедельного задания ступень — это недели, а не дни', () => {
  const t = task({ repeat: 'weekly', cost: 20 });
  let rewards = emptyRewards(), run = emptyRun(t.id), last = null;
  for (let w = 0; w < 5; w++) {
    last = approveTask(rewards, t, run, { now: at(day(2026, 9, 14 + w * 7)) });
    rewards = last.rewards; run = last.run;
  }
  assert.equal(last.streak, 5, 'пять недель подряд, а не пять дней');
  assert.equal(last.bonus, STREAK_BONUS[5]);
  assert.equal(currentRun(t, last.run, { now: at(day(2026, 10, 14)) }).streak, 5, 'в свою неделю серия цела');
});

test('разовое задание серии не заводит', () => {
  const res = approveTask(emptyRewards(), task({ cost: 10 }), emptyRun('trash-1'), { now: at(day(2026, 9, 19)) });
  assert.equal(res.streak, 0);
  assert.equal(res.bonus, 0);
  assert.equal(res.sparkles, 10);
  assert.equal(streakState(task(), res.run).repeating, false);
});

test('дважды за день не платят, а назавтра — снова можно', () => {
  const t = task({ repeat: 'daily', cost: 10 });
  const first = approveTask(emptyRewards(), t, emptyRun(t.id), { now: at(day(2026, 9, 18, 9)) });
  const again = approveTask(first.rewards, t, first.run, { now: at(day(2026, 9, 18, 21)) });
  assert.equal(again.error, 'already-done');
  assert.equal(again.rewards.currency, first.rewards.currency, 'второй раз за сегодня мусор не выносят');
  const tomorrow = approveTask(first.rewards, t, first.run, { now: at(day(2026, 9, 19)) });
  assert.equal(tomorrow.awarded, true);
  assert.equal(tomorrow.streak, 2);
});

test('вчерашнее «сделано» не мешает прислать сегодняшнее фото', () => {
  const t = task({ repeat: 'daily' });
  const done = approveTask(emptyRewards(), t, emptyRun(t.id), { now: at(day(2026, 9, 18)) }).run;
  assert.equal(submitTask(done, photo).error, 'already-done', 'без задания период не угадать');
  const res = submitTask(done, photo, { now: at(day(2026, 9, 19)), task: t });
  assert.equal(res.error, null);
  assert.equal(res.run.status, 'sent');
  assert.equal(res.run.period, '2026-09-19');
  assert.equal(res.run.streak, 1, 'серия едет с заданием, а не теряется при отправке');
});

// ── Повтор на витринах ──────────────────────────────────────────────────────
test('витрины смотрят на задание глазами сегодняшнего дня', () => {
  const tasks = [task({ id: 'a', repeat: 'daily' }), task({ id: 'b' })];
  const runs = [
    { id: 'a', status: 'done', period: '2026-09-18', streak: 2, lastDonePeriod: '2026-09-18', doneCount: 2 },
    { id: 'b', status: 'done', decidedAt: '2026-09-18T10:00:00.000Z' },
  ];
  const now = at(day(2026, 9, 19));
  const inbox = childInbox(tasks, runs, 'maya', { now });
  assert.deepEqual(inbox.todo.map(r => r.task.id), ['a'], 'ежедневное вернулось');
  assert.deepEqual(inbox.done.map(r => r.task.id), ['b'], 'разовое закрыто навсегда');
  assert.equal(inbox.todo[0].run.streak, 2);
  assert.equal(inboxCount(tasks, runs, 'maya', { now }), 1);

  const entries = [{ profile: { id: 'maya', name: 'Майя' }, runs }];
  assert.deepEqual(parentTasks(tasks, entries, { now }).map(r => [r.task.id, r.state]), [['a', 'new'], ['b', 'done']]);
  assert.equal(parentTasks(tasks, entries, { now })[0].streak.streak, 2);
  assert.deepEqual(reviewQueue(tasks, entries, { now }).map(r => r.task.id), [], 'вчерашнее фото сегодня не проверяют');
});

test('состояния не путаются между собой', () => {
  assert.ok(isDone({ status: 'done' }) && !isOpen({ status: 'done' }));
  assert.ok(!isWaiting({ status: 'returned' }) && isOpen({ status: 'returned' }));
  assert.deepEqual([...runsById([{ id: 'a', status: 'sent' }, { taskId: 'b' }, {}]).keys()], ['a', 'b']);
});
