// Бонусные задания (без Firebase/DOM, тестируется в Node).
//
// Зачем: камера видит предметы, но не видит РАБОТУ — вытертую пыль, политый
// цветок, ровный ряд обуви. Проверить это фотографией «после» нельзя (чистый
// стол и невытертый стол выглядят одинаково), зато можно попросить ребёнка
// показать САМО действие: «сфоткай свою руку с тряпкой на столе».
//
// Поэтому бонус проверяется иначе, чем уборка: человек в кадре здесь не ошибка,
// а то, ради чего снимают.
//
// Бонус — добавка, а не работа: он предлагается только после награждённого
// раунда, даёт немного искорок и ограничен по числу за день. Иначе «сфоткай
// руку» превратилось бы в способ получать искорки вместо уборки.
import { normalizeRewards, SPARKLES, SEEN_TAGS, CLEANED_TAGS, normalizeTags } from './family-core.js';
import { dayKey } from './limits-core.js';
import { t } from './i18n.js';

export const BONUS_DAILY_LIMIT = 2; // сколько бонусов в день приносят искорки

// Каталог заданий.
//   roomTypes — null: подходит любой комнате.
//   needs.cleaned — что ребёнок ДОЛЖЕН БЫЛ только что убрать. Протереть стол
//     тряпочкой имеет смысл после уборки стола, а не после сбора игрушек с пола.
//   needs.seen — что должно быть ВИДНО в кадре. «Полей цветок» в комнате без
//     цветка — это не бонус, а случайная придирка.
//   Внутри одного вида требований достаточно ЛЮБОГО совпадения, между видами —
//   нужны все. Нет ни одного подходящего задания — не предлагаем ничего:
//   пустая пауза лучше задания невпопад.
// check — что именно должно быть видно на фото (уходит в промпт проверки).
// title/hint/check — тексты, и живут в словаре по ключам bonus.<id>.*:
//   title — что сделать, hint — что именно сфотографировать,
//   check  — что должно быть видно на фото (уходит в промпт проверки).
export const BONUS_TASKS = [
  {
    id: 'dust', emoji: '🧽', sparkles: 3, roomTypes: null,
    // not: стол, который в маршруте уже протирали шагом «протереть», второй раз
    // тряпочкой просить нелепо — ребёнок только что это и сделал.
    needs: { cleaned: ['surface'], not: ['wiped'] },
  },
  {
    id: 'sweep', emoji: '🧹', sparkles: 3, roomTypes: null,
    needs: { cleaned: ['floor'] },
  },
  {
    id: 'laundry', emoji: '🧺', sparkles: 2, roomTypes: null,
    needs: { cleaned: ['textile'] },
  },
  {
    id: 'plants', emoji: '🪴', sparkles: 2, roomTypes: null,
    needs: { seen: ['plant'] },
  },
  {
    id: 'mirror', emoji: '🪞', sparkles: 3, roomTypes: ['bathroom'],
    needs: { seen: ['mirror'] },
  },
  {
    id: 'shoes', emoji: '👟', sparkles: 2, roomTypes: ['hall'],
    needs: { seen: ['shoes'] },
  },
  {
    id: 'books', emoji: '📚', sparkles: 2, roomTypes: ['bedroom_child', 'living'],
    needs: { seen: ['books'] },
  },
].map(task => ({
  ...task,
  // Геттеры, а не поля: язык переключается без перезагрузки ядра, и задание,
  // выбранное до переключения, должно заговорить на новом языке.
  get title() { return t(`bonus.${this.id}.title`); },
  get hint() { return t(`bonus.${this.id}.hint`); },
  get check() { return t(`bonus.${this.id}.check`); },
}));

export const BONUS_BY_ID = new Map(BONUS_TASKS.map(t => [t.id, t]));
export function bonusTask(id) { return BONUS_BY_ID.get(String(id || '')) || null; }

// Контекст кадра: где убирались, что видно и что уже убрано.
export function bonusContext(raw = {}) {
  const ctx = (raw && typeof raw === 'object') ? raw : {};
  return {
    roomType: ctx.roomType || null,
    seen: normalizeTags(ctx.seen, SEEN_TAGS),
    cleaned: normalizeTags(ctx.cleaned, CLEANED_TAGS),
  };
}
const hits = (need, have) => !need?.length || need.some(t => have.includes(t));
export function bonusFitsContext(task, ctx) {
  const c = bonusContext(ctx);
  if (task.roomTypes && !task.roomTypes.includes(c.roomType)) return false;
  const have = [...c.cleaned, ...c.seen];
  if (task.needs?.not?.some(t => have.includes(t))) return false;
  return hits(task.needs?.cleaned, c.cleaned) && hits(task.needs?.seen, c.seen);
}

// Задания под этот конкретный раунд: сначала специфичные для типа комнаты
// (в ванной — зеркало), потом общие. Ребёнку интереснее то, что про его комнату.
export function bonusesForContext(ctx) {
  const c = bonusContext(ctx);
  const fit = BONUS_TASKS.filter(t => bonusFitsContext(t, c));
  return [...fit.filter(t => t.roomTypes), ...fit.filter(t => !t.roomTypes)];
}
// Только по типу комнаты, без контекста уборки — для подсказок родителю
// («что тут вообще бывает»); подбор для ребёнка идёт через bonusesForContext.
export function bonusesForRoom(roomType) {
  const specific = BONUS_TASKS.filter(t => t.roomTypes?.includes(roomType));
  const common = BONUS_TASKS.filter(t => !t.roomTypes);
  return [...specific, ...common];
}

// ── Дневной счёт бонусов ────────────────────────────────────────────────────
function todayBonus(rewards, now) {
  const r = normalizeRewards(rewards);
  return r.dailyBonus.day === dayKey(now()) ? r.dailyBonus : { day: null, ids: {}, total: 0 };
}
export function bonusesDoneToday(rewards, now = Date.now) {
  return Object.keys(todayBonus(rewards, now).ids);
}
export function bonusTotalToday(rewards, now = Date.now) {
  return todayBonus(rewards, now).total;
}
export function bonusesLeftToday(rewards, { now = Date.now, limit = BONUS_DAILY_LIMIT } = {}) {
  return Math.max(0, limit - bonusTotalToday(rewards, now));
}

// Что предложить сейчас: подходящее ЭТОЙ уборке и ещё не сделанное сегодня.
// Одно и то же задание второй раз за день не предлагаем — приедается.
// ctx — {roomType, seen, cleaned}; строку принимаем как один тип комнаты.
export function pickBonus(rewards, ctx, { now = Date.now, rand = Math.random, limit = BONUS_DAILY_LIMIT } = {}) {
  if (bonusesLeftToday(rewards, { now, limit }) <= 0) return null;
  const done = new Set(bonusesDoneToday(rewards, now));
  const pool = bonusesForContext(typeof ctx === 'string' ? { roomType: ctx } : ctx)
    .filter(t => !done.has(t.id));
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

// Начисление за подтверждённый бонус. Как и уборка, растит и баланс, и
// «заработано за всё время»; счётчик уборок НЕ трогает — бонус не уборка.
export function awardBonus(rewards, task, { now = Date.now, limit = BONUS_DAILY_LIMIT } = {}) {
  const t = bonusTask(task?.id ?? task);
  const out = normalizeRewards(rewards);
  if (!t) return { rewards: out, awarded: false, reason: 'unknown-task', sparkles: 0 };
  const today = dayKey(now());
  const fresh = out.dailyBonus.day === today;
  const ids = fresh ? { ...out.dailyBonus.ids } : {};
  const total = fresh ? out.dailyBonus.total : 0;
  if (total >= limit) return { rewards: out, awarded: false, reason: 'bonus-limit', sparkles: 0 };
  if (ids[t.id]) return { rewards: out, awarded: false, reason: 'already-done', sparkles: 0 };

  const gained = Number(t.sparkles) || SPARKLES.step;
  out.currency += gained;
  out.earnedTotal += gained;
  out.dailyBonus = { day: today, ids: { ...ids, [t.id]: 1 }, total: total + 1 };
  return { rewards: out, awarded: true, reason: null, sparkles: gained };
}
