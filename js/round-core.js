// Чистое ядро РАУНДА уборки — «наведи и убери» (без Firebase/DOM, тестируется в Node).
//
// Раунд = один стоп-кадр, разложенный на шаги. Главное правило §244: ребёнок
// никогда не видит «вот тебе 14 предметов» — в каждый момент показан ровно один
// шаг. Чем шаг является, зависит от режима:
//
//   closeup (режим A) — стол/полка крупным планом. Шаг = ЦВЕТ: все бумаги
//     разом, потом все игрушки. Порядок наш, фиксированный (ROUND_ORDER).
//   overview (режим B) — фото комнаты. Шаг = ОЧАГ: стул с одеждой, пол, стол,
//     урна. Порядок наш, по видам очагов (ZONE_ORDER), а очаг, который с порога
//     видно, но не разглядеть («на столе что-то мелкое»), просит подойти и
//     снять крупным планом — внутри шага открывается вложенный раунд режима A.
//
// Состояние раунда неизменяемое: каждая функция возвращает НОВЫЙ раунд
// (как addCard/addSparkles в family-core). Экран хранит последний и перерисовывается.
import {
  ACTION_IDS, actionCategory, normalizeActionCategory, makeSessionId,
  zoneKind, normalizeZoneKind, SPARKLES, normalizeRewards, nextSurpriseIn, shouldSurprise,
} from './family-core.js';

// ── Порядок цветов в раунде (режим A) ───────────────────────────────────────
// Порядок фиксирован и одинаков в каждом раунде: ребёнок запоминает ритуал
// («сначала мусор, потом посуда…») и перестаёт тратить внимание на выбор.
// Начало — самое заметное и быстрое (мусор, посуда): ранняя победа держит заход.
// Конец — мелкий разбор (канцелярия) и «чужое», куда сил уже почти не надо.
export const ROUND_ORDER = [
  'trash', 'dishes', 'textile', 'toys', 'paper', 'stationery',
  'floor', 'make_bed', 'belongs_elsewhere', 'bin_full',
];
// Категории, которые всегда уезжают в КОНЕЦ раунда. Вынести урну до того, как в
// неё сложили мусор комнаты, — значит нести её дважды.
export const LAST_CATEGORIES = ['bin_full'];
export function isLastCategory(category) {
  return LAST_CATEGORIES.includes(normalizeActionCategory(category));
}
const ORDER_INDEX = new Map(ROUND_ORDER.map((id, i) => [id, i]));
export function orderIndex(category) {
  const cat = normalizeActionCategory(category);
  const i = ORDER_INDEX.get(cat);
  return i === undefined ? ROUND_ORDER.length + ACTION_IDS.indexOf(cat) : i;
}
// Сортировка категорий в порядке раунда (вход не мутирует).
export function orderCategories(categories) {
  return (Array.isArray(categories) ? categories.slice() : []).sort((a, b) => orderIndex(a) - orderIndex(b));
}

// ── Порядок очагов в комнате (режим B) ──────────────────────────────────────
// Раньше порядок обхода отдавался модели целиком: она группирует однотипное, а
// мы не гоняем ребёнка «по своему словарю». На живой комнате это не работало —
// модель сортирует по смыслу вещей, а не по логике уборки, и ребёнок начинал
// разбирать стол, пока на стуле лежала куча одежды.
//
// Порядок теперь наш и повторяет то, как убирается человек:
//   стулья → пол → кровать → подробно стол/полка → протереть → вынести мусор.
// Сначала крупное и быстрое (освободить стул, поднять с пола) — комната меняется
// на глазах с первых минут; мелкая разборка стола идёт, когда вокруг уже чисто;
// протирают освобождённую поверхность, а не заставленную; урна — последней,
// когда весь мусор комнаты уже в ней.
export const ZONE_ORDER = ['chair', 'floor', 'bed', 'desk', 'shelf', 'surface', 'other', 'wipe', 'bin'];
const ZONE_INDEX = new Map(ZONE_ORDER.map((id, i) => [id, i]));
export function zoneOrderIndex(kind) {
  const k = normalizeZoneKind(kind);
  const i = ZONE_INDEX.get(k);
  return i === undefined ? ZONE_ORDER.length : i;
}
// Виды очагов, которые оставляют после себя поверхность: её надо протереть.
const WIPEABLE = ['desk', 'shelf', 'surface'];
// Больше двух протираний за раунд — это уже не уборка, а наказание.
const MAX_WIPES = 2;

// ── Сборка раунда из ответа сканера ─────────────────────────────────────────
// scanned — результат sanitizeScan.
export function buildRound(scanned, {
  roomId = null, roomName = '', themeId = null, profileId = null,
  now = Date.now, rand = Math.random, id = null,
} = {}) {
  const overview = scanned?.mode === 'overview';
  const items = overview ? planZones(scanned?.zones) : (scanned?.items || []).map((it, i) => ({
    id: it.id ?? i + 1, label: it.label || '', category: it.category, box: it.box,
  }));
  // В обходе комнаты каждый очаг — свой шаг; на столе шаг собирает весь цвет.
  const rawSteps = overview
    ? items.map(z => ({ category: z.category, kind: z.kind, itemIds: [z.id], doneAt: null, skipped: false }))
    : orderCategories([...new Set(items.map(it => it.category))]).map(category => ({
        category, kind: null,
        itemIds: items.filter(it => it.category === category).map(it => it.id),
        doneAt: null,
        skipped: false,
      }));
  // «Последние» шаги (полная урна) переносим в конец в ОБОИХ режимах.
  const steps = [
    ...rawSteps.filter(st => !isLastCategory(st.category)),
    ...rawSteps.filter(st => isLastCategory(st.category)),
  ];
  return {
    id: id || makeSessionId(now, rand),
    mode: overview ? 'overview' : 'closeup',
    // Что именно сняли («раковина», «стол у окна») — ключ дневного лимита.
    place: scanned?.place || '',
    estimatedMinutes: overview ? (Number(scanned?.estimated_minutes) || null) : null,
    roomId, roomName, themeId, profileId,
    startedAt: new Date(now()).toISOString(),
    finishedAt: null,
    items, steps,
    index: 0,
    doneItemIds: [],
    // Вещи, которых на самом деле нет («сканер придумал»): не убраны и не
    // считаются, но и шаг из-за них целиком не пропадает.
    droppedItemIds: [],
    sparkles: 0,
    // Вложенный раунд крупного плана (режим A внутри очага) и журнал сделанных.
    sub: null,
    closeups: [],
    // Переменное подкрепление (§330): первый сюрприз — через 2–7 закрытых шагов.
    stepsSinceSurprise: 0,
    surpriseIn: nextSurpriseIn(rand),
    surpriseNow: false,
    verify: null,
  };
}

// Очаги в порядок уборки + производные шаги «протереть».
function planZones(rawZones) {
  const zones = (Array.isArray(rawZones) ? rawZones : []).map((z, i) => ({
    id: Number.isInteger(z.id) ? z.id : i + 1,
    kind: normalizeZoneKind(z.kind),
    label: z.label || '',
    category: z.category,
    point: z.point,
    action: z.action || '',
    itemsEstimate: Number(z.itemsEstimate) || 0,
    needsCloseup: !!z.needsCloseup,
  }));
  // Стабильная сортировка: внутри одного вида очага порядок модели сохраняем —
  // она видела кадр и ставит рядом то, что рядом лежит.
  const ordered = zones
    .map((z, i) => ({ z, i }))
    .sort((a, b) => (zoneOrderIndex(a.z.kind) - zoneOrderIndex(b.z.kind)) || (a.i - b.i))
    .map(x => x.z);
  // «Протереть» модель не подскажет: пыли на фото не видно. Шаг добавляем сами —
  // к той поверхности, которую ребёнок только что освободил.
  const wipes = ordered
    .filter(z => WIPEABLE.includes(z.kind))
    .slice(0, MAX_WIPES)
    .map((z, i) => ({
      id: 1000 + i, kind: 'wipe',
      label: z.label || 'поверхность',
      category: null, point: z.point, itemsEstimate: 0, needsCloseup: false,
      action: `протри ${(z.label || 'поверхность').toLowerCase()}`,
    }));
  if (!wipes.length) return ordered;
  const at = ordered.findIndex(z => zoneOrderIndex(z.kind) >= zoneOrderIndex('wipe'));
  const cut = at === -1 ? ordered.length : at;
  return [...ordered.slice(0, cut), ...wipes, ...ordered.slice(cut)];
}

// ── Вложенный крупный план ──────────────────────────────────────────────────
// Всё, что читает и меняет шаги, работает с АКТИВНЫМ раундом: пока открыт
// крупный план очага, это он. Экран из-за этого не раздваивается — он рисует
// «текущий шаг», не зная, чей именно.
export function activeRound(round) { return round?.sub || round || null; }
function withActive(round, fn) {
  if (round?.sub) return { ...round, sub: fn(round.sub) };
  return fn(round);
}
export function isCloseupOpen(round) { return !!round?.sub; }

// Очаг текущего шага (режим B) — то, что подписано на кадре и о чём говорим.
export function currentZone(round) {
  if (round?.mode !== 'overview' || round?.sub) return null;
  const step = currentStep(round);
  if (!step) return null;
  return (round.items || []).find(z => step.itemIds.includes(z.id)) || null;
}
// Этот очаг просит подойти и снять крупным планом.
export function needsCloseup(round) { return !!currentZone(round)?.needsCloseup; }

// Ребёнок подошёл и снял очаг крупным планом — открываем вложенный раунд.
// Пустой скан («там уже чисто») крупный план не открывает: возвращаем как есть,
// экран увидит `sub === null` и закроет очаг сам.
export function startCloseup(round, scanned, { now = Date.now, rand = Math.random } = {}) {
  const zone = currentZone(round);
  if (!zone) return round;
  const sub = buildRound({ ...(scanned || {}), mode: 'closeup' }, {
    roomId: round.roomId, roomName: round.roomName, themeId: round.themeId,
    profileId: round.profileId, now, rand, id: `${round.id}-z${zone.id}`,
  });
  if (!sub.steps.length) return round;
  return { ...round, sub: { ...sub, zoneId: zone.id, zoneLabel: zone.label } };
}
// Крупный план отработан: искорки уезжают в общий счёт раунда, очаг закрывается.
export function finishCloseup(round, { now = Date.now, rand = Math.random } = {}) {
  const sub = round?.sub;
  if (!sub) return round;
  const merged = {
    ...round,
    sparkles: round.sparkles + sub.sparkles,
    closeups: [...(round.closeups || []), {
      zoneId: sub.zoneId ?? null,
      label: sub.zoneLabel || '',
      steps: sub.steps.length,
      itemsTotal: sub.items.length,
      itemsDone: (sub.doneItemIds || []).length,
      sparkles: sub.sparkles,
    }],
    sub: null,
  };
  return completeStep(merged, { now, rand });
}
// «Уберу и так» / камера не открылась: очаг остаётся обычным шагом.
export function cancelCloseup(round) {
  return round?.sub ? { ...round, sub: null } : round;
}
// Искорки, которые видит ребёнок: свои плюс заработанные в открытом плане.
export function totalSparkles(round) {
  return (round?.sparkles || 0) + (round?.sub?.sparkles || 0);
}

// ── Текущий шаг ─────────────────────────────────────────────────────────────
export function currentStep(round) {
  const r = activeRound(round);
  const steps = r?.steps || [];
  return r && r.index < steps.length ? steps[r.index] : null;
}
export function isFinished(round) {
  const r = activeRound(round);
  return !!r && r.index >= (r.steps?.length || 0);
}
// Предметы текущего шага — ровно то, что подсвечивается на кадре. Вычеркнутые
// («тут такого нет») не показываем и не считаем.
export function stepItems(round) {
  const r = activeRound(round);
  const step = currentStep(round);
  if (!step) return [];
  const dropped = r.droppedItemIds || [];
  return (r.items || []).filter(it => step.itemIds.includes(it.id) && !dropped.includes(it.id));
}
// В шаге не осталось ни одной настоящей вещи — закрывать его нечем.
export function isStepEmpty(round) {
  return !!currentStep(round) && stepItems(round).length === 0;
}
// Всё, что нужно экрану, чтобы нарисовать задание: цвет, эмодзи, текст, счётчик.
// В обходе комнаты у очага есть своё название и своё действие от модели («убери
// одежду со стула») — оно точнее общего текста категории, поэтому идёт первым.
export function stepTask(round) {
  const r = activeRound(round);
  const step = currentStep(round);
  if (!step) return null;
  const overview = r.mode === 'overview';
  const items = stepItems(round);
  const first = items[0] || {};
  const cat = actionCategory(step.category);
  const zone = overview ? zoneKind(step.kind || first.kind) : null;
  const total = step.itemIds.filter(id => !(r.droppedItemIds || []).includes(id)).length;
  const done = step.itemIds.filter(id => (r.doneItemIds || []).includes(id)).length;
  return {
    mode: r.mode || 'closeup',
    category: step.category,
    kind: overview ? (step.kind || first.kind || 'other') : null,
    color: cat?.color || zone?.color || '#9AA3AE',
    emoji: overview ? (zone?.emoji || cat?.emoji || '✨') : cat.emoji,
    // В обходе заголовок — сам очаг («одежда на стуле»), на столе его нет.
    title: overview ? (first.label || zone?.name || '') : '',
    instruction: overview
      ? (first.action || cat?.instruction || zone?.instruction || 'Убери здесь')
      : cat.instruction,
    target: cat?.target || zone?.target || '',
    point: overview ? (first.point || null) : null,
    // Очаг просит крупный план: экран предложит подойти и сфотографировать.
    closeup: overview ? !!first.needsCloseup : false,
    total, done, allChecked: done >= total,
    // Названия предметов — для озвучки и подсказки («тетрадь, журнал, чек»).
    labels: items.map(it => it.label).filter(Boolean),
    number: r.index + 1, of: r.steps.length,
    // Крупный план внутри очага — чтобы экран мог сказать, где ребёнок сейчас.
    inCloseup: !!round?.sub,
    zoneLabel: round?.sub?.zoneLabel || '',
  };
}
export function isItemDone(round, itemId) {
  return (activeRound(round)?.doneItemIds || []).includes(itemId);
}
export function isItemDropped(round, itemId) {
  return (activeRound(round)?.droppedItemIds || []).includes(itemId);
}
// Ребёнок ткнул в подсвеченный предмет — «этот убрал». Переключатель (можно снять).
export function toggleItem(round, itemId) {
  return withActive(round, (r) => {
    const done = r.doneItemIds || [];
    const next = done.includes(itemId) ? done.filter(id => id !== itemId) : [...done, itemId];
    return { ...r, doneItemIds: next, surpriseNow: false };
  });
}
// «Тут такого нет» — ТОЧЕЧНО, по одной вещи. Раньше эта кнопка закрывала шаг
// целиком: одна выдуманная сканером вещь — и ребёнок терял все остальные, что
// в шаге были. Теперь вычёркивается ровно то, чего нет; шаг закрывается сам,
// только когда вычеркнули всё.
export function dropItem(round, itemId) {
  return withActive(round, (r) => {
    const dropped = r.droppedItemIds || [];
    if (dropped.includes(itemId)) return r;
    return {
      ...r,
      droppedItemIds: [...dropped, itemId],
      doneItemIds: (r.doneItemIds || []).filter(id => id !== itemId),
      surpriseNow: false,
    };
  });
}

// ── Закрытие шага ───────────────────────────────────────────────────────────
// Валюта — только за ЗАКРЫТЫЙ шаг (§317), в котором была настоящая работа.
// Штрафов нет (§336): шаг, где всё оказалось выдумкой сканера, просто не платит.
export function completeStep(round, { now = Date.now, rand = Math.random } = {}) {
  return withActive(round, (r) => {
    const step = r.steps[r.index];
    if (!step) return r;
    const dropped = r.droppedItemIds || [];
    const real = step.itemIds.filter(id => !dropped.includes(id));
    // Все вещи шага вычеркнуты — это пропуск, а не уборка.
    if (!real.length) return closeStepAt(r, { now, skipped: true });
    const steps = r.steps.map((s, i) => (i === r.index ? { ...s, doneAt: new Date(now()).toISOString() } : s));
    const doneItemIds = Array.from(new Set([...(r.doneItemIds || []), ...real]));
    const sinceSurprise = (r.stepsSinceSurprise || 0) + 1;
    const surpriseNow = shouldSurprise(sinceSurprise, r.surpriseIn);
    return {
      ...r, steps, doneItemIds,
      index: r.index + 1,
      sparkles: r.sparkles + SPARKLES.step,
      stepsSinceSurprise: surpriseNow ? 0 : sinceSurprise,
      surpriseIn: surpriseNow ? nextSurpriseIn(rand) : r.surpriseIn,
      surpriseNow,
    };
  });
}
// «Тут ничего такого нет» целиком (очаг чистый) — шаг закрывается без начисления.
export function skipStep(round, { now = Date.now } = {}) {
  return withActive(round, (r) => (r.steps[r.index] ? closeStepAt(r, { now, skipped: true }) : r));
}
function closeStepAt(r, { now, skipped }) {
  const steps = r.steps.map((s, i) => (i === r.index ? { ...s, doneAt: new Date(now()).toISOString(), skipped } : s));
  return { ...r, steps, index: r.index + 1, surpriseNow: false };
}

// ── Прогресс (полоска сверху) ───────────────────────────────────────────────
// Крупный план внутри очага считается вместе с комнатой: полоска не должна
// стоять на месте, пока ребёнок разбирает стол.
export function roundProgress(round) {
  const sub = round?.sub || null;
  const stepsTotal = (round?.steps?.length || 0) + (sub?.steps?.length || 0);
  const itemsTotal = (round?.items?.length || 0) + (sub?.items?.length || 0);
  const stepsDone = Math.min(round?.index || 0, round?.steps?.length || 0) + Math.min(sub?.index || 0, sub?.steps?.length || 0);
  const itemsDone = (round?.doneItemIds || []).length + (sub?.doneItemIds || []).length;
  return {
    stepsDone, stepsTotal, itemsDone, itemsTotal,
    percent: stepsTotal ? Math.round((stepsDone / stepsTotal) * 100) : 0,
  };
}

// ── Брифинг перед уборкой (режим B) ─────────────────────────────────────────
// Ребёнок должен увидеть фронт работ и награду ДО первого шага: «если уберёшь
// всю комнату — заработаешь не меньше N». Обещание намеренно занижено: считаем
// только те шаги, что уже видим (крупный план стола добавит искорок сверху).
// Пообещать 15 и дать 11 — хуже, чем пообещать 9 и дать 16.
export function roundBrief(round) {
  const marks = zoneMarkers(round);
  const plan = [];
  const seen = new Set();
  for (const m of marks) {
    const line = m.action || zoneKind(m.kind).plan;
    const key = `${m.kind}::${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    plan.push({ kind: m.kind, emoji: zoneKind(m.kind).emoji, text: line, no: m.no });
  }
  return {
    zones: marks.filter(m => m.no !== null).length,
    steps: round?.steps?.length || 0,
    // «Не меньше»: шаг = искорка, плюс бонус за подтверждённую комнату.
    minSparkles: (round?.steps?.length || 0) * SPARKLES.step + SPARKLES.room,
    minutes: round?.estimatedMinutes || null,
    closeups: (round?.items || []).filter(z => z.needsCloseup).length,
    plan: plan.slice(0, 6),
  };
}

// Метки очагов на кадре — ОДНА нумерация для брифинга и для раунда: ребёнок
// запоминает «мой стол — третий» и находит его на картинке в любой момент.
// «Протереть» своего номера не получает: это не отдельное место, а возвращение
// к уже пройденному (метка у него та же, что у поверхности).
export function zoneMarkers(round) {
  let no = 0;
  return (round?.items || []).map((z) => {
    const kind = normalizeZoneKind(z.kind);
    const numbered = kind !== 'wipe';
    if (numbered) no += 1;
    return {
      id: z.id, no: numbered ? no : null, kind,
      label: z.label || zoneKind(kind).name,
      action: z.action || '',
      point: z.point || [0.5, 0.5],
      color: actionCategory(z.category)?.color || zoneKind(kind).color,
      needsCloseup: !!z.needsCloseup,
    };
  });
}

// ── Что было заданием — одной строкой, для промпта /verify и для истории ────
// Дедупликация обязательна: в комнате несколько очагов могут быть одной
// категорией, и без неё в промпт уедет «Игрушки в ящик; Игрушки в ящик; …».
export function roundTaskText(round) {
  const overview = round?.mode === 'overview';
  const byId = new Map((round?.items || []).map(z => [z.id, z]));
  const done = [...new Set((round?.steps || []).filter(s => s.doneAt && !s.skipped)
    .map((s) => {
      if (!overview) return actionCategory(s.category)?.instruction || '';
      const zone = byId.get(s.itemIds[0]);
      // В комнате точнее говорит сам очаг: «убрать одежду со стула».
      return zone?.action || zone?.label || zoneKind(s.kind || zone?.kind).plan;
    })
    .filter(Boolean))];
  return done.join('; ') || (overview ? 'убрать комнату' : 'убрать поверхность');
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
    place: round.place || '',
    themeId: round.themeId || null,
    startedAt: round.startedAt,
    finishedAt: round.finishedAt,
    durationMs: round.finishedAt ? elapsedMs(round) : null,
    itemsTotal: round.items.length,
    itemsDropped: (round.droppedItemIds || []).length,
    steps: round.steps.map(s => ({
      category: s.category || null, kind: s.kind || null,
      total: s.itemIds.length, doneAt: s.doneAt, skipped: !!s.skipped,
    })),
    // Крупные планы внутри очагов: сколько раз подходили ближе и что там было.
    closeups: (round.closeups || []).map(c => ({
      label: c.label || '', steps: c.steps, itemsTotal: c.itemsTotal, sparkles: c.sparkles,
    })),
    sparkles: round.sparkles,
    verify: round.verify ? {
      done: round.verify.done, status: round.verify.status,
      score: round.verify.score || null, missed: round.verify.missed || [],
    } : null,
  };
}
