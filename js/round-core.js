// Чистое ядро РАУНДА уборки — «наведи и убери» (без Firebase/DOM, тестируется в Node).
//
// Раунд = один стоп-кадр, разложенный по цветам действий. Главное правило §244:
// ребёнок работает ПО ОДНОМУ ЦВЕТУ ЗА РАЗ. Не «вот тебе 14 предметов», а
// «сейчас только синее: собери бумаги — их четыре». Поэтому раунд — это не
// список предметов, а очередь шагов-цветов, каждый со своим счётчиком.
//
// Состояние раунда неизменяемое: каждая функция возвращает НОВЫЙ раунд
// (как addCard/addSparkles в family-core). Экран хранит последний и перерисовывается.
import {
  ACTION_IDS, actionCategory, makeSessionId,
  SPARKLES, normalizeRewards, nextSurpriseIn, shouldSurprise,
} from './family-core.js';

// ── Порядок цветов в раунде ─────────────────────────────────────────────────
// Порядок фиксирован и одинаков в каждом раунде: ребёнок запоминает ритуал
// («сначала мусор, потом посуда…») и перестаёт тратить внимание на выбор.
// Начало — самое заметное и быстрое (мусор, посуда): ранняя победа держит заход.
// Конец — мелкий разбор (канцелярия) и «чужое», куда сил уже почти не надо.
export const ROUND_ORDER = ['trash', 'dishes', 'clothes', 'toys', 'paper', 'stationery', 'belongs_elsewhere'];
const ORDER_INDEX = new Map(ROUND_ORDER.map((id, i) => [id, i]));
export function orderIndex(category) {
  const i = ORDER_INDEX.get(category);
  return i === undefined ? ROUND_ORDER.length + ACTION_IDS.indexOf(category) : i;
}
// Сортировка категорий в порядке раунда (вход не мутирует).
export function orderCategories(categories) {
  return (Array.isArray(categories) ? categories.slice() : []).sort((a, b) => orderIndex(a) - orderIndex(b));
}

// ── Сборка раунда из ответа сканера ─────────────────────────────────────────
// Два режима, ОДНА структура раунда — экран и начисления не раздваиваются:
//
//   closeup (режим A, §244) — стол/полка крупным планом. Шаг = ЦВЕТ: все бумаги
//     разом, потом все игрушки. Предметы с рамками (box), порядок наш (ROUND_ORDER).
//   overview (режим B, §268) — обход комнаты. Шаг = ОДНА ТОЧКА на полу: «синий
//     грузовик → в ящик». Порядок оставляем модельный: она уже сгруппировала
//     однотипное подряд, а физически ребёнок ходит по комнате, и перескакивать
//     через неё «по нашему словарю» значило бы гонять его туда-сюда.
//
// scanned — результат sanitizeScan.
export function buildRound(scanned, {
  roomId = null, roomName = '', themeId = null, profileId = null,
  now = Date.now, rand = Math.random, id = null,
} = {}) {
  const overview = scanned?.mode === 'overview';
  const items = overview
    ? (scanned?.route || []).map((st, i) => ({
        id: Number.isInteger(st.step) ? st.step : i + 1,
        label: st.label || '', category: st.category,
        point: st.point, action: st.action || '',
      }))
    : (scanned?.items || []).map((it, i) => ({
        id: it.id ?? i + 1, label: it.label || '', category: it.category, box: it.box,
      }));
  // В обходе каждая точка — свой шаг; на столе шаг собирает весь цвет.
  const steps = overview
    ? items.map(it => ({ category: it.category, itemIds: [it.id], doneAt: null, skipped: false }))
    : orderCategories([...new Set(items.map(it => it.category))]).map(category => ({
        category,
        itemIds: items.filter(it => it.category === category).map(it => it.id),
        doneAt: null,
        skipped: false,
      }));
  return {
    id: id || makeSessionId(now, rand),
    mode: overview ? 'overview' : 'closeup',
    estimatedMinutes: overview ? (Number(scanned?.estimated_minutes) || null) : null,
    roomId, roomName, themeId, profileId,
    startedAt: new Date(now()).toISOString(),
    finishedAt: null,
    items, steps,
    index: 0,
    doneItemIds: [],
    sparkles: 0,
    // Переменное подкрепление (§330): первый сюрприз — через 2–7 закрытых шагов.
    stepsSinceSurprise: 0,
    surpriseIn: nextSurpriseIn(rand),
    surpriseNow: false,
    verify: null,
  };
}

// ── Текущий шаг ─────────────────────────────────────────────────────────────
export function currentStep(round) {
  const steps = round?.steps || [];
  return round && round.index < steps.length ? steps[round.index] : null;
}
export function isFinished(round) {
  return !!round && round.index >= (round.steps?.length || 0);
}
// Предметы текущего шага — ровно то, что подсвечивается на кадре (один цвет).
export function stepItems(round) {
  const step = currentStep(round);
  if (!step) return [];
  return (round.items || []).filter(it => step.itemIds.includes(it.id));
}
// Всё, что нужно экрану, чтобы нарисовать задание: цвет, эмодзи, текст, счётчик.
// В обходе комнаты у шага есть имя предмета и своё действие от модели («в ящик
// с игрушками») — оно точнее общего «Игрушки в свой ящик», поэтому идёт первым.
export function stepTask(round) {
  const step = currentStep(round);
  if (!step) return null;
  const cat = actionCategory(step.category);
  const total = step.itemIds.length;
  const done = step.itemIds.filter(id => (round.doneItemIds || []).includes(id)).length;
  const items = stepItems(round);
  const overview = round.mode === 'overview';
  const first = items[0] || {};
  return {
    mode: round.mode || 'closeup',
    category: step.category,
    color: cat.color, emoji: cat.emoji,
    // В обходе заголовок — сам предмет («синий грузовик»), на столе его нет.
    title: overview ? (first.label || '') : '',
    instruction: overview ? (first.action || cat.instruction) : cat.instruction,
    target: cat.target,
    point: overview ? (first.point || null) : null,
    total, done, allChecked: done >= total,
    // Названия предметов — для озвучки и подсказки («тетрадь, журнал, чек»).
    labels: items.map(it => it.label).filter(Boolean),
    number: round.index + 1, of: round.steps.length,
  };
}
export function isItemDone(round, itemId) {
  return (round?.doneItemIds || []).includes(itemId);
}
// Ребёнок ткнул в подсвеченный предмет — «этот убрал». Переключатель (можно снять).
export function toggleItem(round, itemId) {
  const done = round.doneItemIds || [];
  const next = done.includes(itemId) ? done.filter(id => id !== itemId) : [...done, itemId];
  return { ...round, doneItemIds: next, surpriseNow: false };
}

// ── Закрытие шага ───────────────────────────────────────────────────────────
// Валюта — только за ЗАКРЫТЫЙ шаг (§317), и только за «Готово», не за «пропустить».
// Штрафов нет (§336): пропуск просто не начисляет.
export function completeStep(round, { now = Date.now, rand = Math.random } = {}) {
  const step = currentStep(round);
  if (!step) return round;
  const steps = round.steps.map((s, i) => (i === round.index ? { ...s, doneAt: new Date(now()).toISOString() } : s));
  // Всё в шаге считаем убранным, даже если ребёнок не тыкал в каждый предмет.
  const doneItemIds = Array.from(new Set([...(round.doneItemIds || []), ...step.itemIds]));
  const sinceSurprise = (round.stepsSinceSurprise || 0) + 1;
  const surpriseNow = shouldSurprise(sinceSurprise, round.surpriseIn);
  return {
    ...round, steps, doneItemIds,
    index: round.index + 1,
    sparkles: round.sparkles + SPARKLES.step,
    stepsSinceSurprise: surpriseNow ? 0 : sinceSurprise,
    surpriseIn: surpriseNow ? nextSurpriseIn(rand) : round.surpriseIn,
    surpriseNow,
  };
}
// «Тут ничего такого нет» — сканер ошибся. Шаг закрывается без начисления.
export function skipStep(round, { now = Date.now } = {}) {
  const step = currentStep(round);
  if (!step) return round;
  const steps = round.steps.map((s, i) => (i === round.index ? { ...s, doneAt: new Date(now()).toISOString(), skipped: true } : s));
  return { ...round, steps, index: round.index + 1, surpriseNow: false };
}

// ── Прогресс (полоска сверху) ───────────────────────────────────────────────
export function roundProgress(round) {
  const stepsTotal = round?.steps?.length || 0;
  const itemsTotal = round?.items?.length || 0;
  const stepsDone = Math.min(round?.index || 0, stepsTotal);
  const itemsDone = (round?.doneItemIds || []).length;
  return {
    stepsDone, stepsTotal, itemsDone, itemsTotal,
    percent: stepsTotal ? Math.round((stepsDone / stepsTotal) * 100) : 0,
  };
}
// Что было заданием — одной строкой, для промпта /verify и для истории.
// Дедупликация обязательна: в обходе комнаты десять точек могут быть одной
// категорией, и без неё в промпт уедет «Игрушки в ящик; Игрушки в ящик; …».
export function roundTaskText(round) {
  const done = [...new Set((round?.steps || []).filter(s => s.doneAt && !s.skipped)
    .map(s => actionCategory(s.category)?.instruction).filter(Boolean))];
  return done.join('; ') || (round?.mode === 'overview' ? 'убрать комнату' : 'убрать поверхность');
}

// ── Финал раунда: проверка «после» ──────────────────────────────────────────
// verifyResult — результат sanitizeVerify. Бонус за комнату — только при done.
export function finishRound(round, verifyResult, { now = Date.now } = {}) {
  const done = verifyResult?.done === true;
  return {
    ...round,
    finishedAt: new Date(now()).toISOString(),
    verify: verifyResult || null,
    sparkles: round.sparkles + (done ? SPARKLES.room : 0),
    surpriseNow: false,
  };
}
export function elapsedMs(round, now = Date.now) {
  if (!round?.startedAt) return 0;
  const end = round.finishedAt ? Date.parse(round.finishedAt) : now();
  return Math.max(0, end - Date.parse(round.startedAt));
}
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const m = Math.floor(total / 60), s = Math.floor(total % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Начисление на ребёнка ───────────────────────────────────────────────────
// Валюта — общая (принадлежит ребёнку, не теме, §49). Счётчик уборок растёт
// только за подтверждённый проверкой раунд — иначе он перестаёт что-то значить.
// Заработанное падает в ДВА счётчика: currency (баланс, его тратят на реальные
// награды) и earnedTotal (за всё время, не убывает — от него ранг и статус).
export function applyRoundToRewards(rewards, round) {
  const out = normalizeRewards(rewards);
  const gained = Number(round?.sparkles) || 0;
  out.currency += gained;
  out.earnedTotal += gained;
  if (round?.finishedAt && round?.verify?.done === true) out.cleanupsTotal += 1;
  return out;
}

// Документ для families/{fid}/profiles/{pid}/progress/{sessionId}.
// Кадры не сохраняем (§420: фото уборки живут на планшете) — только факты.
export function sessionFromRound(round) {
  return {
    id: round.id,
    mode: round.mode || 'closeup',
    profileId: round.profileId || null,
    roomId: round.roomId || null,
    roomName: round.roomName || '',
    themeId: round.themeId || null,
    startedAt: round.startedAt,
    finishedAt: round.finishedAt,
    durationMs: round.finishedAt ? elapsedMs(round) : null,
    itemsTotal: round.items.length,
    steps: round.steps.map(s => ({
      category: s.category, total: s.itemIds.length, doneAt: s.doneAt, skipped: !!s.skipped,
    })),
    sparkles: round.sparkles,
    verify: round.verify ? {
      done: round.verify.done, status: round.verify.status,
      score: round.verify.score || null, missed: round.verify.missed || [],
    } : null,
  };
}
