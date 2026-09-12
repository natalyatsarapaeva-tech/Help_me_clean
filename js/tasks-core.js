// Задания от родителя (без Firebase/DOM, тестируется в Node).
//
// Зачем: всё, за что ребёнок получал искорки, до сих пор придумывало приложение
// — сканер нашёл работу в кадре, бонус выбрался из каталога по контексту. Но
// половина домашних дел камере не видна и в комнату не помещается: «вынеси
// мусор», «сложи бельё», «полей цветы у бабушки». Такое задание знает только
// родитель, и цену ему тоже назначает он: ни одна модель не догадается, что
// вынести мусор в этой семье стоит десять искорок, а вымыть посуду — двадцать.
//
// Поэтому задание здесь — целиком родительское: текст, цена, исполнитель и
// (по желанию) комната. Приложение ничего не выдумывает и ничего не оценивает.
//
// Проверка — ФОТОГРАФИЕЙ, но без ИИ. Ребёнок снимает сделанное, фото уезжает в
// родительский кабинет, и родитель решает сам. Причины не звать модель:
//   — заданий она не понимает: «полей цветы у бабушки» проверить по кадру
//     нельзя, не зная ни бабушки, ни цветов;
//   — цену назначал человек, пусть человек и принимает работу — иначе выходит,
//     что родитель обещал награду, а отказывает в ней машина;
//   — вызов vision стоит денег и упирается в дневной бюджет, который нужнее
//     самой уборке.
//
// Одно задание — один исполнитель. «Помойте посуду» на двоих детей упирается в
// вопрос, кому достанутся искорки за одно фото; экран родителя вместо этого
// заводит по заданию на каждого ребёнка — каждому своё, каждому своя цена.
//
// Данные разложены так же, как у остальных экранов семьи:
//   families/{fid}/tasks/{taskId}            — само задание (пишет родитель)
//   families/{fid}/profiles/{pid}/tasks/{id} — ход выполнения (пишет ребёнок,
//                                              решение принимает родитель)
// Ход выполнения живёт в поддереве ребёнка не случайно: туда ему открыт доступ
// правилами, а в каталог заданий — нет (см. firestore.rules).
import { normalizeRewards } from './family-core.js';

export const MAX_TASK_TITLE = 80;
export const MAX_TASK_NOTE = 200;
export const MAX_TASK_COST = 999;   // выше — это уже опечатка, а не награда
export const ANY_ROOM = null;       // задание может быть и без комнаты

// Состояния задания глазами семьи:
//   new      — выдано, ребёнок ещё не присылал фото;
//   sent     — фото прислано, ждёт родителя;
//   returned — родитель вернул на переделку (с комментарием), это НЕ отказ;
//   done     — засчитано, искорки начислены. Конечное состояние.
export const TASK_STATUSES = ['new', 'sent', 'returned', 'done'];
export function isValidTaskStatus(s) { return TASK_STATUSES.includes(String(s)); }

export function makeTaskId(title, rand = Math.random) {
  const slug = String(title || 'task').toLowerCase()
    .replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'task';
  return `${slug.slice(0, 24)}-${Math.floor(rand() * 1e6).toString(36)}`;
}

// ── Задание ─────────────────────────────────────────────────────────────────
// Без текста, исполнителя или цены задания нет: пустая строка в списке ребёнка
// хуже отсутствующей строки, а задание без цены пришлось бы оценивать нам.
export function normalizeTask(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const id = String(r.id || '').trim();
  const title = String(r.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_TITLE);
  const profileId = String(r.profileId || '').trim();
  const cost = Math.floor(Number(r.cost));
  if (!id || !title || !profileId) return null;
  if (!Number.isFinite(cost) || cost < 1 || cost > MAX_TASK_COST) return null;
  return {
    id, title, profileId, cost,
    note: String(r.note || '').trim().slice(0, MAX_TASK_NOTE),
    // Комната — необязательная привязка: «вынеси мусор» не живёт ни в одной.
    roomId: r.roomId ? String(r.roomId) : ANY_ROOM,
    // Имя комнаты копируется в задание: список ребёнка не должен ради одной
    // подписи читать карту дома, а переименование комнаты не меняет того,
    // что родитель имел в виду, когда задание выдавал.
    roomName: String(r.roomName || '').trim().slice(0, MAX_TASK_TITLE),
    createdAt: r.createdAt || null,
  };
}
// Порядок — от старых к новым: что выдано раньше, то и делается раньше.
export function normalizeTasks(list) {
  return (Array.isArray(list) ? list : []).map(normalizeTask).filter(Boolean)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}
export function tasksForProfile(tasks, profileId) {
  const pid = String(profileId || '');
  return normalizeTasks(tasks).filter(t => t.profileId === pid);
}

// ── Ход выполнения ──────────────────────────────────────────────────────────
// Документа может не быть вовсе — это и есть «new»: заводить пустышку на каждое
// выданное задание незачем.
export function emptyRun(taskId) {
  return {
    taskId: String(taskId || ''), status: 'new',
    url: null, path: null, w: null, h: null,
    sentAt: null, decidedAt: null, note: '',
  };
}
export function normalizeRun(raw, taskId) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const id = String(taskId || r.taskId || r.id || '').trim();
  const base = emptyRun(id);
  const status = isValidTaskStatus(r.status) ? String(r.status) : 'new';
  return {
    ...base,
    status,
    url: String(r.url || '').trim() || null,
    path: String(r.path || '').trim() || null,
    w: Number(r.w) || null, h: Number(r.h) || null,
    sentAt: r.sentAt || null,
    decidedAt: r.decidedAt || null,
    // Комментарий родителя при возврате: «стол вижу, а пол?». Возврат без слов
    // читается как «не поверили», и это самое обидное, что тут можно сделать.
    note: String(r.note || '').trim().slice(0, MAX_TASK_NOTE),
  };
}
export function runsById(list) {
  const map = new Map();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const id = String(raw?.id || raw?.taskId || '').trim();
    if (id) map.set(id, normalizeRun(raw, id));
  }
  return map;
}
export function runFor(runs, taskId) {
  const map = runs instanceof Map ? runs : runsById(runs);
  return map.get(String(taskId)) || emptyRun(taskId);
}
export function taskState(run) { return normalizeRun(run).status; }
export function isWaiting(run) { return taskState(run) === 'sent'; }
export function isDone(run) { return taskState(run) === 'done'; }
// Что ребёнку ещё делать: свежее и возвращённое. «Ждёт проверки» не его забота.
export function isOpen(run) { const s = taskState(run); return s === 'new' || s === 'returned'; }

// ── Ребёнок: прислать фото ──────────────────────────────────────────────────
// photo — уже загруженный в Storage кадр: { url, path, w, h }. Загрузку делает
// экран (js/store.js), ядро только меняет состояние.
export function submitTask(run, photo, { now = Date.now } = {}) {
  const cur = normalizeRun(run);
  if (cur.status === 'done') return { run: cur, error: 'already-done' };
  const url = String(photo?.url || '').trim();
  if (!url) return { run: cur, error: 'no-photo' };
  return {
    run: {
      ...cur, status: 'sent', url,
      path: String(photo?.path || '').trim() || null,
      w: Number(photo?.w) || null, h: Number(photo?.h) || null,
      sentAt: new Date(now()).toISOString(),
      decidedAt: null,
      note: '', // прошлый комментарий родителя относился к прошлому фото
    },
    error: null,
  };
}

// ── Родитель: засчитать ─────────────────────────────────────────────────────
// Начисляем РОВНО столько, сколько назначил родитель: цену задания приложение
// не правит и не «нормализует» вверх.
//
// Счётчик уборок (и ранг от него) задание НЕ трогает — как и бонусы: ранг
// растёт за пройденные раунды уборки, иначе его можно было бы выписать себе
// десятком заданий по искорке.
//
// Повторное «засчитать» ничего не делает: родитель на планшете нажимает кнопку
// дважды легко, а вторая выплата за одно фото — это уже сломанная экономика.
export function approveTask(rewards, task, run, { now = Date.now } = {}) {
  const out = normalizeRewards(rewards);
  const cur = normalizeRun(run, task?.id);
  const t = normalizeTask(task);
  if (!t) return { rewards: out, run: cur, sparkles: 0, awarded: false, error: 'unknown-task' };
  if (cur.status === 'done') return { rewards: out, run: cur, sparkles: 0, awarded: false, error: 'already-done' };
  const gained = t.cost;
  out.currency += gained;
  out.earnedTotal += gained;
  return {
    rewards: out,
    // Фото остаётся в записи: родителю видно, за что заплачено, и ребёнку тоже.
    run: { ...cur, taskId: t.id, status: 'done', decidedAt: new Date(now()).toISOString(), note: '' },
    sparkles: gained, awarded: true, error: null,
  };
}

// Вернуть на переделку — это не наказание и не отказ: искорки не отнимаются
// (их ещё и не было), задание просто снова становится открытым.
export function returnTask(run, note, { now = Date.now } = {}) {
  const cur = normalizeRun(run);
  if (cur.status === 'done') return { run: cur, error: 'already-done' };
  return {
    run: {
      ...cur, status: 'returned',
      decidedAt: new Date(now()).toISOString(),
      note: String(note || '').trim().slice(0, MAX_TASK_NOTE),
    },
    error: null,
  };
}

// ── Витрина ребёнка: «Входящие» ─────────────────────────────────────────────
// Три полки, и все три нужны: что делать, что уже отправлено (чтобы не
// пересылать одно и то же) и что засчитано (ради чего всё затевалось).
export function childInbox(tasks, runs, profileId) {
  const mine = tasksForProfile(tasks, profileId);
  const map = runs instanceof Map ? runs : runsById(runs);
  const rows = mine.map(task => ({ task, run: runFor(map, task.id) }));
  const todo = rows.filter(r => isOpen(r.run));
  const waiting = rows.filter(r => isWaiting(r.run));
  const done = rows.filter(r => isDone(r.run));
  return {
    todo, waiting, done,
    // Сколько можно заработать тем, что ещё не сделано: «на что копить» из
    // магазина работает, только если видно, откуда взять.
    sparklesTodo: todo.reduce((n, r) => n + r.task.cost, 0),
    sparklesWaiting: waiting.reduce((n, r) => n + r.task.cost, 0),
  };
}
// Цифра для кнопки на детском экране: только то, что ждёт самого ребёнка.
export function inboxCount(tasks, runs, profileId) {
  return childInbox(tasks, runs, profileId).todo.length;
}

// ── Кабинет родителя ────────────────────────────────────────────────────────
// entries — [{ profile, runs }] по всем детям семьи (у каждого своё поддерево).
// Очередь проверки — общая и в порядке присылки: кто первым прислал, того
// первым и смотрят.
export function reviewQueue(tasks, entries) {
  const all = normalizeTasks(tasks);
  const out = [];
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    const profile = entry?.profile || null;
    if (!profile?.id) continue;
    const map = runsById(entry?.runs);
    for (const task of all) {
      if (task.profileId !== profile.id) continue;
      const run = runFor(map, task.id);
      if (isWaiting(run)) out.push({ profile, task, run });
    }
  }
  return out.sort((a, b) => String(a.run.sentAt || '').localeCompare(String(b.run.sentAt || '')));
}
// Полный список заданий семьи с их состоянием — чтобы родитель видел не только
// очередь, но и то, что висит невыполненным неделю.
export function parentTasks(tasks, entries) {
  const byProfile = new Map();
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    if (entry?.profile?.id) byProfile.set(entry.profile.id, { profile: entry.profile, runs: runsById(entry.runs) });
  }
  return normalizeTasks(tasks).map(task => {
    const owner = byProfile.get(task.profileId) || null;
    const run = runFor(owner?.runs || new Map(), task.id);
    return { task, run, profile: owner?.profile || null, state: run.status };
  });
}
