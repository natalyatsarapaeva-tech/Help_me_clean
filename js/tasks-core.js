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
// Задание может ПОВТОРЯТЬСЯ (каждый день / неделю / месяц): домашние дела тем и
// отличаются от разовых просьб, что мусор выносят не один раз в жизни. Повтор
// не плодит документы — задание остаётся одним, а ход выполнения помнит, за
// КАКОЙ период он сделан (см. periodKey ниже). Пришёл новый период — задание
// само снова становится открытым.
//
// За серию повторов подряд полагается добавка (см. STREAK_BONUS): пять дней
// подряд выносить мусор — это не пять раз вынести мусор, это привычка, и
// платить за неё ровно столько же было бы нечестно.
//
// Данные разложены так же, как у остальных экранов семьи:
//   families/{fid}/tasks/{taskId}            — само задание (пишет родитель)
//   families/{fid}/profiles/{pid}/tasks/{id} — ход выполнения (пишет ребёнок,
//                                              решение принимает родитель)
// Ход выполнения живёт в поддереве ребёнка не случайно: туда ему открыт доступ
// правилами, а в каталог заданий — нет (см. firestore.rules).
import { normalizeRewards } from './family-core.js';
import { dayKey } from './limits-core.js';

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

// ── Повтор ──────────────────────────────────────────────────────────────────
// Разовое задание («вынеси коробки на помойку перед переездом») и домашняя
// обязанность («выноси мусор») — разные вещи, а заводились одинаково: родителю
// приходилось каждый вечер выдавать одно и то же заново, и половина обязанностей
// так и не доживала до второго дня.
//
// Периоды взяты ровно те, которыми семья и живёт: день, неделя, месяц. Часов и
// «каждые три дня» тут нет намеренно — расписание, которое нельзя удержать в
// голове, ребёнок воспринимает как случайность.
export const REPEATS = ['none', 'daily', 'weekly', 'monthly'];
export function isValidRepeat(r) { return REPEATS.includes(String(r)); }
export function normalizeRepeat(r) { return isValidRepeat(r) ? String(r) : 'none'; }
export function isRepeating(r) { return normalizeRepeat(r) !== 'none'; }

// Ключ периода — то, за что задание считается сделанным. Он лежит в документе
// ребёнка, поэтому должен быть читаемым глазами и стабильным:
//   daily   → 2026-09-19        (день ребёнка, а не UTC-сутки — как в лимитах)
//   weekly  → W2026-09-14       (понедельник этой недели; неделя начинается с
//                                понедельника, как школьная)
//   monthly → M2026-09
//   none    → once              (у разового задания период один — «навсегда»)
// Неделя названа датой понедельника, а не номером: номера ISO-недель на стыке
// года расходятся с календарём, и отлаживать это в детском приложении — худшее
// применение чьего-либо времени.
export function mondayKey(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // вс = 0 → 6 дней назад
  return dayKey(d.getTime());
}
export function monthKey(ts = Date.now()) { return dayKey(ts).slice(0, 7); }
export function periodKey(repeat, ts = Date.now()) {
  switch (normalizeRepeat(repeat)) {
    case 'daily': return dayKey(ts);
    case 'weekly': return `W${mondayKey(ts)}`;
    case 'monthly': return `M${monthKey(ts)}`;
    default: return 'once';
  }
}
// Номер периода: соседние периоды отличаются на единицу — по этому и видно,
// не порвалась ли серия. Чужой или испорченный ключ даёт null: серия тогда
// начинается заново, а не продолжается наугад (родитель мог переключить
// задание с ежедневного на еженедельное, и старые ключи стали не те).
const DAY_MS = 86400000;
function dayNumber(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS : null;
}
export function periodOrdinal(repeat, key) {
  const k = String(key || '');
  switch (normalizeRepeat(repeat)) {
    case 'daily': return dayNumber(k);
    // 1970-01-01 — четверг, поэтому понедельники становятся кратны семи со
    // сдвигом на 3 дня; деление тогда точное, без округлений.
    case 'weekly': { const n = dayNumber(k.slice(1)); return k[0] === 'W' && n !== null ? (n + 3) / 7 : null; }
    case 'monthly': { const m = /^M(\d{4})-(\d{2})$/.exec(k); return m ? +m[1] * 12 + (+m[2] - 1) : null; }
    default: return k === 'once' ? 0 : null;
  }
}
// Идут ли периоды подряд (вчера → сегодня, прошлая неделя → эта).
export function isNextPeriod(repeat, prevKey, key) {
  const a = periodOrdinal(repeat, prevKey), b = periodOrdinal(repeat, key);
  return a !== null && b !== null && b - a === 1;
}

// ── Серия (страйк) ──────────────────────────────────────────────────────────
// Ступени — «сколько раз подряд», и для ежедневного задания это ровно дни: пять
// дней подряд, неделя, десять, две недели, месяц. У еженедельного задания та же
// пятёрка означает пять недель подряд: считать его серию в днях было бы
// самообманом — ребёнок сделал работу пять раз, а не тридцать пять.
//
// Добавка растёт быстрее ступеней: тридцатая уборка подряд — это не «ещё одна»,
// и платить за неё как за пятую значит сказать ребёнку, что месяц привычки не
// стоит ничего. Цену самого задания назначает родитель, а добавка одна на всех:
// иначе задание за искорку приносило бы сотню за серию (§336 — отбирать уже
// начисленное мы всё равно не станем, значит и раздавать вслепую нельзя).
export const STREAK_STEPS = [5, 7, 10, 15, 30];
export const STREAK_BONUS = { 5: 5, 7: 10, 10: 20, 15: 30, 30: 100 };
const TOP_STEP = STREAK_STEPS[STREAK_STEPS.length - 1];

// Сколько добавить за серию длиной n. Ноль — если это не ступень: добавка
// платится в момент её взятия, а не каждый раз потом.
// После месяца ступени не кончаются: серия в 60 и 90 повторов снова приносит
// «месячную» добавку — иначе после тридцатого дня держать привычку не за что.
export function streakBonus(streak) {
  const n = Math.floor(Number(streak) || 0);
  if (n <= 0) return 0;
  if (STREAK_BONUS[n]) return STREAK_BONUS[n];
  return n > TOP_STEP && n % TOP_STEP === 0 ? STREAK_BONUS[TOP_STEP] : 0;
}
// Следующая ступень — чтобы ребёнку было видно, ради чего не бросать: «ещё два
// раза — и +10». Цель без цифры не работает.
export function nextStreakStep(streak) {
  const n = Math.max(0, Math.floor(Number(streak) || 0));
  const at = STREAK_STEPS.find(s => s > n) ?? (Math.floor(n / TOP_STEP) + 1) * TOP_STEP;
  return { at, need: at - n, bonus: streakBonus(at) };
}

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
    // Повтор — свойство задания, а не хода выполнения: «как часто» решает
    // родитель, и решение это переживает любое количество фотографий.
    repeat: normalizeRepeat(r.repeat),
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
    // Повтор: за какой период этот ход выполнения. Пришёл новый период —
    // задание снова открыто, а числа серии переезжают в него как есть.
    period: null,
    streak: 0, bestStreak: 0, doneCount: 0,
    lastDonePeriod: null, lastDoneAt: null,
  };
}
export function normalizeRun(raw, taskId) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const id = String(taskId || r.taskId || r.id || '').trim();
  const base = emptyRun(id);
  const status = isValidTaskStatus(r.status) ? String(r.status) : 'new';
  const count = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const streak = count(r.streak);
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
    period: String(r.period || '').trim() || null,
    streak,
    // Лучшая серия не сбрасывается никогда: рекорд — это достигнутое, а
    // достигнутое не отбирают (§336). Сорванная серия обнуляет только текущую.
    bestStreak: Math.max(count(r.bestStreak), streak),
    doneCount: count(r.doneCount),
    lastDonePeriod: String(r.lastDonePeriod || '').trim() || null,
    lastDoneAt: r.lastDoneAt || null,
  };
}

// Ход выполнения В ТЕКУЩЕМ ПЕРИОДЕ. Всё, что показывает и решает приложение,
// смотрит на задание через эту функцию: в базе документ один, а «сделано» у
// повторяющегося задания живёт ровно один период.
//
// Перекатывание НЕ пишется в базу: запись случится сама, когда ребёнок пришлёт
// фото или родитель нажмёт кнопку. Иначе каждое открытие экрана дёргало бы
// Firestore ради строки, которая и так вычисляется из даты.
export function currentRun(task, run, { now = Date.now } = {}) {
  const t = normalizeTask(task);
  const cur = normalizeRun(run, task?.id ?? run?.taskId ?? run?.id);
  if (!t || !isRepeating(t.repeat)) return cur;
  const key = periodKey(t.repeat, now());
  // Старые документы (и задания, которые родитель сделал повторяющимися уже
  // после выдачи) периода не знают — восстанавливаем его по дате решения или
  // отправки. Иначе разово сделанное задание осталось бы «сделанным» навсегда.
  const stamp = cur.decidedAt || cur.sentAt;
  const was = cur.period || (stamp ? periodKey(t.repeat, Date.parse(stamp)) : null);
  // Присланное фото остаётся в СВОЁМ периоде, даже когда наступил следующий:
  // ребёнок вечером сделал работу, родитель смотрит утром — и должен увидеть её
  // в очереди, а не обнаружить, что она растворилась вместе со вчерашним днём.
  if (was === key || cur.status === 'sent') return { ...cur, period: was || key };
  // Серия жива, только если прошлое «засчитано» пришлось на предыдущий период
  // или на этот: пропущенный день серию рвёт, и показывать «🔥 5» после
  // пропуска — врать ребёнку.
  const alive = cur.lastDonePeriod
    && (cur.lastDonePeriod === key || isNextPeriod(t.repeat, cur.lastDonePeriod, key));
  const streak = alive ? cur.streak : 0;
  // Засчитанное в прошлом периоде — задание открывается заново, с чистым листом
  // и целой серией.
  if (cur.status === 'done') {
    return {
      ...emptyRun(cur.taskId),
      period: key, streak,
      bestStreak: cur.bestStreak,
      doneCount: cur.doneCount,
      lastDonePeriod: cur.lastDonePeriod,
      lastDoneAt: cur.lastDoneAt,
    };
  }
  // Не сделанное (или возвращённое на переделку) просто переезжает в текущий
  // период: задание и так открыто, а замечание родителя остаётся в силе —
  // стирать его на смене суток было бы потерей единственного объяснения.
  return { ...cur, period: key, streak };
}

// Что показать про серию рядом с заданием: сколько уже подряд, следующая
// ступень и не висит ли серия на волоске (сделано в прошлом периоде, в этом
// ещё нет).
export function streakState(task, run, { now = Date.now } = {}) {
  const t = normalizeTask(task);
  const cur = currentRun(t, run, { now });
  const repeating = !!t && isRepeating(t.repeat);
  const next = nextStreakStep(cur.streak);
  return {
    repeating,
    streak: repeating ? cur.streak : 0,
    best: repeating ? cur.bestStreak : 0,
    next: repeating ? next : { at: 0, need: 0, bonus: 0 },
    // Серия есть, и в этом периоде ещё есть что делать — момент, ради которого
    // всё и затевалось: «не потеряй». Отправленное фото уже не «на волоске»:
    // ребёнок своё сделал, дальше очередь родителя.
    atRisk: repeating && cur.streak > 0 && isOpen(cur),
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
// task — необязателен, но если он передан, ход выполнения сначала перекатится в
// текущий период: иначе вчерашнее «сделано» не дало бы прислать фото сегодня.
export function submitTask(run, photo, { now = Date.now, task = null } = {}) {
  const cur = task ? currentRun(task, run, { now }) : normalizeRun(run);
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
// У повторяющегося задания «повторное» считается по периоду: второй раз за
// сегодня мусор не выносят, а завтра — снова можно.
//
// Серия считается ЗДЕСЬ, а не на экране: добавка за неё — такая же выплата, и
// решаться она должна там же, где выплата, одной операцией с ней.
export function approveTask(rewards, task, run, { now = Date.now } = {}) {
  const out = normalizeRewards(rewards);
  const t = normalizeTask(task);
  const cur = t ? currentRun(t, run, { now }) : normalizeRun(run, task?.id);
  if (!t) return { rewards: out, run: cur, sparkles: 0, cost: 0, bonus: 0, streak: 0, step: 0, awarded: false, error: 'unknown-task' };
  if (cur.status === 'done') return { rewards: out, run: cur, sparkles: 0, cost: 0, bonus: 0, streak: cur.streak, step: 0, awarded: false, error: 'already-done' };

  const repeating = isRepeating(t.repeat);
  // Период берётся у самого хода выполнения, а не у часов родителя: работа
  // сделана тогда, когда её сделал ребёнок. Иначе вчерашнее фото, засчитанное
  // утром, съедало бы сегодняшний день — и серия считалась бы по тому, когда у
  // родителя дошли руки.
  const key = (repeating && cur.period) || periodKey(t.repeat, now());
  // Серия продолжается, если прошлый раз пришёлся на предыдущий период; в
  // остальных случаях (пропуск, первый раз, смена периодичности) она начинается
  // с единицы — но начинается, а не обнуляется: сегодняшняя работа сделана.
  const streak = repeating
    ? (isNextPeriod(t.repeat, cur.lastDonePeriod, key) ? cur.streak + 1 : 1)
    : 0;
  const bonus = repeating ? streakBonus(streak) : 0;
  const gained = t.cost + bonus;
  out.currency += gained;
  out.earnedTotal += gained;
  const at = new Date(now()).toISOString();
  return {
    rewards: out,
    // Фото остаётся в записи: родителю видно, за что заплачено, и ребёнку тоже.
    run: {
      ...cur, taskId: t.id, status: 'done', decidedAt: at, note: '',
      period: key,
      streak, bestStreak: Math.max(cur.bestStreak, streak),
      doneCount: cur.doneCount + 1,
      lastDonePeriod: repeating ? key : cur.lastDonePeriod,
      lastDoneAt: at,
    },
    // sparkles — сколько всего начислено; cost и bonus — из чего это сложилось,
    // чтобы экран мог сказать «+10 и ещё +20 за серию», а не одно число.
    sparkles: gained, cost: t.cost, bonus, streak,
    step: bonus > 0 ? streak : 0,
    awarded: true, error: null,
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
export function childInbox(tasks, runs, profileId, { now = Date.now } = {}) {
  const mine = tasksForProfile(tasks, profileId);
  const map = runs instanceof Map ? runs : runsById(runs);
  const rows = mine.map(task => ({ task, run: currentRun(task, runFor(map, task.id), { now }) }));
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
export function inboxCount(tasks, runs, profileId, { now = Date.now } = {}) {
  return childInbox(tasks, runs, profileId, { now }).todo.length;
}

// ── Кабинет родителя ────────────────────────────────────────────────────────
// entries — [{ profile, runs }] по всем детям семьи (у каждого своё поддерево).
// Очередь проверки — общая и в порядке присылки: кто первым прислал, того
// первым и смотрят.
export function reviewQueue(tasks, entries, { now = Date.now } = {}) {
  const all = normalizeTasks(tasks);
  const out = [];
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    const profile = entry?.profile || null;
    if (!profile?.id) continue;
    const map = runsById(entry?.runs);
    for (const task of all) {
      if (task.profileId !== profile.id) continue;
      const run = currentRun(task, runFor(map, task.id), { now });
      if (isWaiting(run)) out.push({ profile, task, run });
    }
  }
  return out.sort((a, b) => String(a.run.sentAt || '').localeCompare(String(b.run.sentAt || '')));
}
// Полный список заданий семьи с их состоянием — чтобы родитель видел не только
// очередь, но и то, что висит невыполненным неделю.
export function parentTasks(tasks, entries, { now = Date.now } = {}) {
  const byProfile = new Map();
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    if (entry?.profile?.id) byProfile.set(entry.profile.id, { profile: entry.profile, runs: runsById(entry.runs) });
  }
  return normalizeTasks(tasks).map(task => {
    const owner = byProfile.get(task.profileId) || null;
    const run = currentRun(task, runFor(owner?.runs || new Map(), task.id), { now });
    return {
      task, run, profile: owner?.profile || null, state: run.status,
      streak: streakState(task, run, { now }),
    };
  });
}
