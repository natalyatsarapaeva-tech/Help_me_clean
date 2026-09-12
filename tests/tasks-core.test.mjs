// Тесты заданий от родителя (node --test, без Firebase/DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TASK_COST, TASK_STATUSES,
  makeTaskId, normalizeTask, normalizeTasks, tasksForProfile,
  emptyRun, normalizeRun, runsById, runFor, taskState, isOpen, isWaiting, isDone,
  submitTask, approveTask, returnTask,
  childInbox, inboxCount, reviewQueue, parentTasks,
} from '../js/tasks-core.js';
import { emptyRewards } from '../js/family-core.js';

const at = (t) => () => t;
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

test('состояния не путаются между собой', () => {
  assert.ok(isDone({ status: 'done' }) && !isOpen({ status: 'done' }));
  assert.ok(!isWaiting({ status: 'returned' }) && isOpen({ status: 'returned' }));
  assert.deepEqual([...runsById([{ id: 'a', status: 'sent' }, { taskId: 'b' }, {}]).keys()], ['a', 'b']);
});
