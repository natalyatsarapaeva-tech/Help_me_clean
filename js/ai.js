// Вызовы LLM с vision через СУЩЕСТВУЮЩИЙ тонкий прокси Worker `/ai` (путь B1).
// Воркер не меняем: он принимает payload OpenAI chat completions и возвращает
// ответ OpenAI (ключ на стороне воркера). Промпты и разбор — на клиенте, ровно
// как в twin-things js/ai.js. Origin github.io уже в allow-list воркера.
//
// §442: строгая JSON-схема → один повтор при невалидном ответе → санитайз.
// Санитайзеры (sanitizeScan/Verify/Home) — в family-core.js (чистые, тестируемые).
import {
  ACTION_CATEGORIES, ROOM_TYPES, roomTypeLabel,
  sanitizeScan, sanitizeVerify, sanitizeHome, parseJsonObject,
} from './family-core.js';

// Тот же воркер, что у twin (task-intake-worker). Endpoint /ai — прокси OpenAI.
export const WORKER_URL = 'https://task-intake-worker.ntsarapaeva.workers.dev';
const MODEL = 'gpt-4o';

// Низкоуровневый вызов: payload OpenAI → content первого сообщения.
async function chat(payload, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${WORKER_URL}/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) { const e = new Error('budget-exceeded'); e.code = 429; throw e; }
    if (!res.ok) throw new Error(data?.error?.message || `Ошибка ИИ (${res.status})`);
    return data.choices?.[0]?.message?.content || '';
  } finally { clearTimeout(timer); }
}

// Обёртка «получить валидный JSON-объект»: один повтор, если разбор пуст (§442).
async function jsonCall(payload, sanitize, isEmpty) {
  let content = await chat(payload);
  let out = sanitize(parseJsonObject(content));
  if (isEmpty(out)) {
    content = await chat({ ...payload, temperature: 0 });
    out = sanitize(parseJsonObject(content));
  }
  return out;
}

const dataUrl = (b64) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } });

// ── §178 — описание дома текстом → структура этажей/комнат ───────────────────
const homeSystem = () => `Ты помощник, который строит карту дома по описанию. Верни ТОЛЬКО JSON-объект, без markdown:
{"floors":[{"name":"...","rooms":[{"id":"kitchen","name":"Кухня","type":"kitchen","icon":"🍳","surfaces":["стол","пол"],"typical_clutter":["посуда","крошки"],"needs_confirmation":false}]}]}

Правила:
- Не выдумывай комнаты, которых нет в тексте.
- type — РОВНО ОДИН из: ${ROOM_TYPES.map(t => `${t} (${roomTypeLabel(t)})`).join(', ')}.
- id — короткий латиницей, уникальный (kitchen, bath_1, maya_room…).
- icon — один подходящий эмодзи.
- surfaces и typical_clutter — 2–4 типичных для этого типа комнаты (для подсказок сканера).
- needs_confirmation: true, если название неоднозначно (напр. «детская» — чья).
- Этажи — в порядке сверху вниз, если из текста ясно.`;

export async function parseHome(text) {
  return jsonCall(
    { model: MODEL, max_tokens: 1500, temperature: 0,
      messages: [
        { role: 'system', content: homeSystem() },
        { role: 'user', content: 'Описание дома:\n\n' + String(text || '') },
      ] },
    sanitizeHome,
    (o) => !o.floors.length,
  );
}

// ── §223/§268 — стоп-кадр → подсветка (closeup) или маршрут (overview) ──────
const colorDict = () => ACTION_CATEGORIES
  .map(c => `${c.id} — ${c.instruction} (${c.target})`).join('\n');

function scanSystem(mode) {
  const dict = colorDict();
  if (mode === 'overview') {
    return `Ты помощник по уборке. На фото — комната. Составь маршрут обхода предметов на полу/поверхностях. Верни ТОЛЬКО JSON:
{"mode":"overview","route":[{"step":1,"label":"синий грузовик","point":[0.22,0.71],"action":"в ящик с игрушками","category":"toys"}],"estimated_minutes":6}

Правила:
- category — РОВНО ОДИН id из списка ниже, не выдумывай:
${dict}
- point — [x,y] в долях кадра 0..1 (x слева направо, y сверху вниз).
- Порядок маршрута — сначала всё однотипное (все игрушки), потом следующая группа: меньше переключений внимания.
- Если человек в кадре — верни {"person_detected":true}.`;
  }
  return `Ты помощник по уборке. На фото — стол/полка/поверхность крупным планом. Найди предметы, которые надо убрать, и отнеси каждый к ОДНОЙ категории действия. Верни ТОЛЬКО JSON:
{"mode":"closeup","items":[{"id":1,"label":"тетрадь","category":"paper","box":[0.12,0.34,0.28,0.51],"confidence":0.86}],"surface_state":"messy"}

Правила:
- category — РОВНО ОДИН id из списка ниже, не выдумывай:
${dict}
- box — прямоугольник вокруг предмета в НОРМАЛИЗОВАННЫХ углах [x1,y1,x2,y2] (верхний-левый и нижний-правый), каждое число 0..1.
- Не выдумывай предметов, которых нет. Один предмет — один объект.
- Если человек в кадре — верни {"person_detected":true}.`;
}

export async function scan(base64, { mode = 'closeup', roomType, roomName } = {}) {
  const hint = `Комната: ${roomName || '—'}${roomType ? ` (тип: ${roomType})` : ''}. Определи предметы и верни JSON по схеме.`;
  return jsonCall(
    { model: MODEL, max_tokens: 1500, temperature: 0,
      messages: [
        { role: 'system', content: scanSystem(mode) },
        { role: 'user', content: [dataUrl(base64), { type: 'text', text: hint }] },
      ] },
    sanitizeScan,
    (o) => o.mode === 'overview' ? !o.route.length : !o.items.length,
  );
}

// ── §287/§294 — проверка «до/после» (+ эталон §300). Мягкая оценка ──────────
const verifySystem = `Ты добрый помощник, который проверяет уборку у ребёнка 7 лет. Верни ТОЛЬКО JSON:
{"done":true,"score":"great","praise":"Стол чистый!","missed":[]}

Правила (самое важное — не убить мотивацию):
- Считай выполненным (done:true), если убрано БОЛЬШИНСТВО предметов. Идеал не требуется.
- score — one of: great | good | ok.
- praise — короткая добрая фраза по-русски о том, что стало чисто. Никогда не критикуй ребёнка, только называй предметы.
- Если done:false — в missed ровно ОДНА оставшаяся вещь (не список).
- Если кадр плохой (смазан, не тот ракурс) — не проваливай, верни {"retake":true}.
- Если в кадре человек — верни {"person_detected":true}.
- Если дан эталон — оценивай, насколько «после» ближе к эталону, чем «до».`;

export async function verify({ imageBefore, imageAfter, task, referenceUrl }) {
  const content = [];
  if (imageBefore) { content.push({ type: 'text', text: 'Фото ДО:' }, dataUrl(imageBefore)); }
  content.push({ type: 'text', text: 'Фото ПОСЛЕ:' }, dataUrl(imageAfter));
  if (referenceUrl) { content.push({ type: 'text', text: 'Эталон (как должно выглядеть убранным):' }, { type: 'image_url', image_url: { url: referenceUrl, detail: 'high' } }); }
  content.push({ type: 'text', text: `Задание было: ${task || 'убрать поверхность'}. Оцени по правилам и верни JSON.` });
  return jsonCall(
    { model: MODEL, max_tokens: 500, temperature: 0.2,
      messages: [{ role: 'system', content: verifySystem }, { role: 'user', content }] },
    sanitizeVerify,
    () => false, // любой разобранный ответ приемлем; повтор не нужен
  );
}

// ── §327 — одна живая фраза персонажа под то, что реально произошло ──────────
export async function reward(context) {
  const content = await chat({
    model: MODEL, max_tokens: 80, temperature: 0.9,
    messages: [
      { role: 'system', content: 'Ты весёлый персонаж-помощник в детском приложении про уборку. Ответь ОДНОЙ короткой живой фразой по-русски под то, что произошло. Без кавычек, без критики, только позитив и азарт.' },
      { role: 'user', content: `Что произошло: ${typeof context === 'string' ? context : JSON.stringify(context)}` },
    ],
  });
  return String(content || '').trim().replace(/^["'«]|["'»]$/g, '');
}
