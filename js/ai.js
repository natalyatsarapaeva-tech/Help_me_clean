// Вызовы LLM с vision через Cloudflare Worker (перенос паттерна Twin js/ai.js).
// Ключ живёт в воркере, в браузер не попадает. Маршруты приложения — под
// префиксом /tidy/* (§176), чтобы не пересекаться с существующими эндпоинтами.
// Лимиты — по deviceId в заголовке (§174).
//
// Требование §442: строгая JSON-схема → один повтор при невалидном → санитайз.
// Санитайзеры (sanitizeScan/Verify/Home) — в family-core.js (чистые, тестируемые).
import { sanitizeScan, sanitizeVerify, sanitizeHome, parseJsonObject } from './family-core.js';
import { auth } from './firebase.js';

// ⚠️ ЗАПОЛНИТЬ: URL воркера (тот же, что у Twin — добавить маршруты /tidy/*).
export const WORKER_URL = 'https://REPLACE_ME.workers.dev';

// deviceId для лимитов воркера (§174). Стабильный на устройство.
const DEVICE_KEY = 'tidy.deviceId';
export function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = 'dev-' + crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}

async function call(path, body, { timeoutMs = 20000 } = {}) {
  const token = await auth.currentUser?.getIdToken().catch(() => null);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${WORKER_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId(),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) { const e = new Error('budget-exceeded'); e.code = 429; throw e; } // §176: «Сканер отдыхает»
    if (!res.ok) throw new Error(data?.error || `Ошибка ИИ (${res.status})`);
    return data;
  } finally { clearTimeout(timer); }
}

// §178 — описание дома текстом → структура этажей/комнат.
export async function parseHome(text) {
  const data = await call('/tidy/parse-home', { text });
  return sanitizeHome(data);
}

// §223/§268 — стоп-кадр → подсветка (closeup) или маршрут (overview).
// base64 — JPEG без префикса data: (из image.prepareScanFrame).
export async function scan(base64, { mode = 'closeup', roomType, roomName } = {}) {
  const data = await call('/tidy/scan', { image: base64, mode, roomType, roomName });
  return sanitizeScan(data);
}

// §287 — проверка «до/после» с опциональным эталоном (§300).
export async function verify({ imageBefore, imageAfter, task, referenceUrl }) {
  const data = await call('/tidy/verify', { imageBefore, imageAfter, task, referenceUrl });
  return sanitizeVerify(data);
}

// §327 — одна живая фраза персонажа под то, что реально произошло.
export async function reward(context) {
  const data = await call('/tidy/reward', { context });
  const obj = parseJsonObject(typeof data === 'string' ? data : JSON.stringify(data));
  return String(obj.phrase || data?.phrase || '').trim();
}

// §438 — остаток дневного бюджета/лимита.
export async function health() {
  const res = await fetch(`${WORKER_URL}/tidy/health`, { headers: { 'X-Device-Id': deviceId() } });
  return res.json().catch(() => ({}));
}
