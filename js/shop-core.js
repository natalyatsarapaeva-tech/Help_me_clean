// Чистое ядро РЕАЛЬНЫХ НАГРАД (без Firebase/DOM, тестируется в Node).
//
// Искорки перестают быть валютой в никуда: родитель заводит список того, на что
// их можно обменять в реальной жизни (мороженое, лишний час игры, выбор фильма
// на вечер), ребёнок «покупает», родитель выдаёт.
//
//   families/{fid}/realRewards/{id}   — витрина семьи (пишет родитель)
//   .../profiles/{pid}/rewards/current
//        currency     — БАЛАНС: уменьшается покупкой
//        earnedTotal  — заработано за всё время: покупка его НЕ трогает,
//                       поэтому ранг и статус ребёнка от трат не падают
//        realRewards  — список покупок: что куплено и что уже выдано
import { normalizeRewards } from './family-core.js';

// ── Витрина ─────────────────────────────────────────────────────────────────
export function normalizeRealReward(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const id = String(r.id || '').trim();
  const name = String(r.name || '').trim();
  // Цена НЕ поднимается до минимума молча: пустое или нулевое поле — это
  // недозаполненная награда, и её лучше не показывать вовсе, чем отдавать даром.
  const cost = Math.floor(Number(r.cost));
  if (!id || !name || !Number.isFinite(cost) || cost < 1) return null;
  return { id, name, cost, emoji: String(r.emoji || '🎁').slice(0, 4), createdAt: r.createdAt || null };
}
export function normalizeShop(list) {
  return (Array.isArray(list) ? list : []).map(normalizeRealReward).filter(Boolean)
    .sort((a, b) => a.cost - b.cost); // от дешёвого к дорогому: ближняя цель первой
}
export function makeRewardId(name, rand = Math.random) {
  const slug = String(name || 'reward').toLowerCase()
    .replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'reward';
  return `${slug.slice(0, 24)}-${Math.floor(rand() * 1e6).toString(36)}`;
}

// ── Покупка ─────────────────────────────────────────────────────────────────
export function canAfford(rewards, item) {
  const it = normalizeRealReward(item);
  return !!it && normalizeRewards(rewards).currency >= it.cost;
}
export function makePurchaseId(now = Date.now, rand = Math.random) {
  return `buy-${now()}-${Math.floor(rand() * 1e6).toString(36)}`;
}

// Списывает баланс и кладёт покупку в очередь на выдачу. earnedTotal и
// cleanupsTotal не трогаются: потратить — не значит откатить достигнутое.
// Не хватает искорок — возвращаем ошибку и НЕ меняем награды.
export function buyReward(rewards, item, { now = Date.now, rand = Math.random } = {}) {
  const it = normalizeRealReward(item);
  const out = normalizeRewards(rewards);
  if (!it) return { rewards: out, purchase: null, error: 'bad-item' };
  if (out.currency < it.cost) return { rewards: out, purchase: null, error: 'not-enough' };
  const purchase = {
    id: makePurchaseId(now, rand),
    rewardId: it.id, name: it.name, emoji: it.emoji, cost: it.cost,
    boughtAt: new Date(now()).toISOString(),
    givenAt: null,
  };
  out.currency -= it.cost;
  out.realRewards = [...out.realRewards, purchase];
  return { rewards: out, purchase, error: null };
}

// ── Выдача (родитель) ───────────────────────────────────────────────────────
export function purchases(rewards) {
  return normalizeRewards(rewards).realRewards
    .filter(p => p && p.id)
    .map(p => ({ ...p, givenAt: p.givenAt || null }));
}
export function pendingPurchases(rewards) { return purchases(rewards).filter(p => !p.givenAt); }
export function givenPurchases(rewards) { return purchases(rewards).filter(p => p.givenAt); }

export function markGiven(rewards, purchaseId, { now = Date.now } = {}) {
  const out = normalizeRewards(rewards);
  out.realRewards = out.realRewards.map(p => (p?.id === purchaseId && !p.givenAt)
    ? { ...p, givenAt: new Date(now()).toISOString() } : p);
  return out;
}

// ── Витрина для ребёнка ─────────────────────────────────────────────────────
// Показываем и то, что пока не по карману: видно, к чему копить (§336).
// nextGoal — ближайшая недоступная награда и сколько до неё осталось.
export function shopView(catalog, rewards) {
  const r = normalizeRewards(rewards);
  const items = normalizeShop(catalog).map(it => ({
    ...it, affordable: r.currency >= it.cost, missing: Math.max(0, it.cost - r.currency),
  }));
  const nextGoal = items.find(it => !it.affordable) || null;
  return {
    items, balance: r.currency, earnedTotal: r.earnedTotal,
    pending: pendingPurchases(r), nextGoal,
  };
}
