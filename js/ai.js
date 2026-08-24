// Вызовы LLM с vision через СУЩЕСТВУЮЩИЙ тонкий прокси Worker `/ai` (путь B1).
// Воркер не меняем: он принимает payload OpenAI chat completions и возвращает
// ответ OpenAI (ключ на стороне воркера). Промпты и разбор — на клиенте, ровно
// как в twin-things js/ai.js. Origin github.io уже в allow-list воркера.
//
// §442: строгая JSON-схема → один повтор при невалидном ответе → санитайз.
// Санитайзеры (sanitizeScan/Verify/Home) — в family-core.js (чистые, тестируемые).
//
// Промпты — по-английски: модель понимает их точнее, а язык ОТВЕТА задаётся
// отдельной строкой (outputLangRule). Так один набор промптов обслуживает оба
// языка интерфейса, и всё, что читает ребёнок — подписи предметов, похвала,
// подсказки, — приходит на языке, выбранном в родительской части.
import {
  actionCategories, ACTION_IDS, ROOM_TYPES, roomTypeLabel, tidyStandardText,
  verifyLimitsText, seenTagsText,
  sanitizeScan, sanitizeVerify, sanitizeBonus, sanitizeHome, parseJsonObject,
} from './family-core.js';
import { t, getLang, LANG_PROMPT_NAMES, DEFAULT_LANG } from './i18n.js';

// Язык, на котором модель должна писать всё, что увидит человек. Служебные поля
// схемы (id категорий, kind, статусы) остаются английскими всегда — это данные.
function outputLang() { return LANG_PROMPT_NAMES[getLang()] || LANG_PROMPT_NAMES[DEFAULT_LANG]; }
function outputLangRule(fields) {
  return `- LANGUAGE: write every human-readable string (${fields}) in ${outputLang()}. `
    + `Field names, ids and enum values stay exactly as written in this schema.`;
}

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
    if (!res.ok) throw new Error(data?.error?.message || t('ai.error', { status: res.status }));
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
const homeSystem = () => `You build a map of a home from a free-text description. Return ONLY a JSON object, no markdown:
{"floors":[{"name":"...","rooms":[{"id":"kitchen","name":"Kitchen","type":"kitchen","icon":"🍳","surfaces":["worktop","floor"],"typical_clutter":["dishes","crumbs"],"needs_confirmation":false}]}]}

Rules:
- Do not invent rooms that are not in the text.
- type — EXACTLY ONE of: ${ROOM_TYPES.map(x => `${x} (${roomTypeLabel(x)})`).join(', ')}.
- id — short, latin letters, unique (kitchen, bath_1, maya_room…).
- icon — one fitting emoji.
- surfaces — the SPOTS of the room that get tidied one by one: desk, shelf, bed, nightstand, sink, floor.
  Write down the ones NAMED in the text FIRST, word for word as the person named them ("desk by the window").
  Not named — suggest 2–4 typical for that room type.
  Each one is a short singular name, capitalised, up to 24 characters.
- typical_clutter — 2–4 items typical of that room type (they feed the scanner's hints).
- needs_confirmation: true when the name is ambiguous (e.g. "the kids' room" — whose?).
- Floors go top to bottom when the text makes the order clear.
${outputLangRule('floor names, room names, surfaces, typical_clutter')}`;

export async function parseHome(text) {
  return jsonCall(
    { model: MODEL, max_tokens: 1500, temperature: 0,
      messages: [
        { role: 'system', content: homeSystem() },
        { role: 'user', content: 'Description of the home:\n\n' + String(text || '') },
      ] },
    sanitizeHome,
    (o) => !o.floors.length,
  );
}

// ── §223/§268 — стоп-кадр → подсветка предметов (closeup) или очаги (overview) ─
// Инструкции категорий берутся из словаря на языке интерфейса — так подпись в
// промпте и подпись на экране у ребёнка совпадают слово в слово.
const colorDict = () => actionCategories()
  .map(c => `${c.id} — ${c.instruction} (${c.target})`).join('\n')
  + `

Notes on the categories:
- textile — ANYTHING made of fabric: clothes, towels, cloths, socks, bedding, rugs.
  Do not decide whether it is clean or dirty.
- floor — things that do not belong ON THE FLOOR even when they are useful: boxes,
  crates, bags, cables and extension leads, piles of stuff against the wall.
- make_bed — an unmade bed (rumpled duvet, disturbed bedding). ONE object for the
  whole bed, with the box around the whole bed. Leave a made bed alone.
- bin_full — a FULL or noticeably filled bin / waste-paper basket in the frame.
  Exactly one such object per room. Do not add an empty bin.
- belongs_elsewhere — the thing is not where it belongs, and none of the categories
  above fit: it lives in another room.`;

// Имя предмета для ребёнка: конкретное, если видно, общее — если нет.
const LABEL_RULE = `- label — what a child would call the thing. When it is obvious what it is,
  be specific ("jeans", "socks", "mug"); when it is not, use a general word
  ("towel", "cloth", "box"). Do not invent details.`;

// Норма порядка — общая для сканера и проверки (family-core.tidyStandard).
const standard = () => `What counts as tidy:\n${tidyStandardText()}`;

// Контекст для бонусных заданий: «полей цветок» имеет смысл там, где цветок
// есть. Спрашиваем тем же вызовом, что ищет работу, — отдельный вызов ИИ ради
// одного списка не окупается.
const seenRule = () => `- seen — what ELSE is in the frame from this list (nothing from the list — return an empty list). The tags themselves stay in English, they are ids:
${seenTagsText()}`;

// Место в кадре — ключ дневного лимита: одна и та же раковина не должна
// приносить награду бесконечно, но другой угол той же комнаты — должен.
const placeRule = (surfaces) => `- place — a SHORT name for the spot that was photographed
  (2–3 words, no prepositions): "the sink", "desk by the window", "floor by the door".${
  surfaces?.length ? `\n  If one of this room's known surfaces fits, take it from THERE
  word for word: ${surfaces.join(', ')}.` : ''}
  Always give the same spot the SAME name across different photos.`;

function scanSystem(mode, surfaces) {
  const dict = colorDict();
  const places = placeRule(surfaces);
  if (mode === 'overview') {
    return `You are a tidying-up assistant. The photo shows a whole room. Split the work into CLUTTER SPOTS (zones) — the way a person walking into the room would name them: "clothes on the chair", "boxes on the floor", "the desk is buried", "a full bin". Do NOT list individual things: a spot is a place, not an object. Return ONLY JSON:
{"mode":"overview","place":"kids room","zones":[{"id":1,"kind":"chair","label":"clothes on the chair","point":[0.22,0.55],"category":"textile","action":"take the clothes off the chair","items_estimate":3,"needs_closeup":false},{"id":2,"kind":"desk","label":"writing desk","point":[0.61,0.42],"category":"paper","action":"tidy up the desk","items_estimate":9,"needs_closeup":true}],"seen":["plant"],"estimated_minutes":12}

${standard()}

Rules:
- Between 2 and 7 spots. Fewer than two only when the room is nearly tidy. Similar things next to each other (three boxes by the wall) are ONE spot, not three.
- kind — EXACTLY ONE of: chair (things on a chair or armchair), floor (things lying on the floor), bed (an unmade bed), desk (a desk, writing or coffee table), shelf (a shelf or shelving unit), surface (a chest of drawers, windowsill, sideboard), bin (a full bin), other (everything else).
- category — what to do with this spot, EXACTLY ONE id from the list below, do not invent any:
${dict}
- label — what a child would call this place: "clothes on the chair", "boxes by the wardrobe", "the desk".
- action — what exactly to do, as a short phrase addressed to the child: "take the clothes off the chair", "carry the boxes to the wardrobe".
- items_estimate — roughly how many things are in this spot (a number).
${places}
- point — [x,y] of the centre of the spot as fractions of the frame, 0..1 (x left to right, y top to bottom).
${seenRule()}
- needs_closeup — true when from this vantage point you can SEE that there is a mess but cannot MAKE OUT what exactly it is: small stuff on a desk, a buried shelf. The child will then walk up and take a close-up. For a chair with clothes, boxes on the floor, a bed or a bin it is false: those are clear enough as they are.
- estimated_minutes — roughly how many minutes the whole room will take.
- If a person is in the frame — return {"person_detected":true}.
${outputLangRule('label, action, place')}`;
  }
  return `You are a tidying-up assistant. The photo shows a desk, a shelf or another surface close up. Find EVERYTHING that keeps the surface from being tidy by the standard below, and assign each object to ONE action category. Return ONLY JSON:
{"mode":"closeup","place":"the sink","items":[{"id":1,"label":"notebook","category":"paper","box":[0.12,0.34,0.28,0.51],"confidence":0.86}],"seen":["plant"],"surface_state":"messy"}

${standard()}

Rules:
- category — EXACTLY ONE id from the list below, do not invent any:
${dict}
${LABEL_RULE}
${places}
- box — a rectangle around the object in NORMALISED corners [x1,y1,x2,y2] (top-left and bottom-right), every number 0..1.
- Do not invent objects that are not there. One object — one entry.
${seenRule()}
- If a person is in the frame — return {"person_detected":true}.
${outputLangRule('label, place')}`;
}

export async function scan(base64, { mode = 'closeup', roomType, roomName, surfaces, zone } = {}) {
  // zone — крупный план внутри обхода комнаты: снят конкретный очаг («стол»),
  // и модель не должна уезжать на фон и размечать пол за столом.
  const hint = `Room: ${roomName || '—'}${roomType ? ` (type: ${roomType})` : ''}.${
    zone ? ` The photo is a close-up of: ${zone}. Mark up only that spot, leave the background alone.` : ''
  } Identify the objects and return JSON per the schema.`;
  return jsonCall(
    { model: MODEL, max_tokens: 1500, temperature: 0,
      messages: [
        { role: 'system', content: scanSystem(mode, surfaces) },
        { role: 'user', content: [dataUrl(base64), { type: 'text', text: hint }] },
      ] },
    sanitizeScan,
    (o) => o.mode === 'overview' ? !o.zones.length : !o.items.length,
  );
}

// ── §287/§294 — проверка «до/после» (+ эталон §300) ─────────────────────────
// Мягкая по форме, строгая по существу: модель СЧИТАЕТ, что осталось лишнего,
// а проходную планку ставит код (VERIFY_LIMITS в family-core). Раньше «оцени
// мягко, идеал не требуется» отдавало решение настроению модели, и уборка
// засчитывалась при заваленном столе.
const verifySystem = () => `You are a kind assistant checking a 7-year-old's tidying up. You COUNT the objects on two photos of the same surface — "before" and "after" — and show what is still left. Return ONLY JSON:
{"before_count":10,"after_count":4,"score":"good","praise":"You are almost there!","left":[{"label":"scraps of paper","count":3,"category":"trash","todo":"throw out three scraps of paper"},{"label":"mug","count":1,"category":"dishes","todo":"put the mug back where it belongs"}],"boxes":[{"label":"scrap of paper","box":[0.12,0.34,0.19,0.41]}]}

What counts as tidy:
${tidyStandardText()}

The bar (this is what decides whether the tidy-up counts):
${verifyLimitsText()}

Rules:
- FIRST count the stray objects on the BEFORE photo (before_count), then on the AFTER photo (after_count). Both numbers are required — the result is computed from them.
- Stray means anything on the surface beyond the standard above. Do not count furniture, appliances, a lamp or ONE pile of papers on a writing desk.
- The two frames may be taken from different distances and angles: compare what IS LYING on the surface, not how the photo looks.
- If "after" is no different from "before", count it that way: after_count will equal before_count. Do not shade it down out of politeness, that does not help the child.
- left — what is still there, grouped by kind, with counts. Nothing on the surface — return "left": [] and "after_count": 0.
- category — EXACTLY ONE id: ${ACTION_IDS.join(', ')}.
- todo — a ready-made phrase saying what to do about it, in the infinitive and with the number spelled out: "throw out three scraps of paper", "put the dishes back", "hang up the cardigan".
- boxes — a rectangle around EVERY remaining stray object on the AFTER photo, in normalised corners [x1,y1,x2,y2] (0..1). Up to 12 of them. The child sees them drawn on their own photo — without them they will not know what exactly to put away.
- Whether it counts or not is decided by the app from the numbers, you do not need to think about it. Do not return a "done" field.
- praise — a short, lively phrase. If something is still left, encourage and keep them going: "You are almost there!", "Wow, look at all that space! Just a bit more". If it is tidy, be genuinely pleased with the result.
- NEVER criticise the child or call them messy: talk about the objects only.
- score — one of: great | good | ok.
- If the AFTER photo is of the wrong surface, or taken so that the surface is not visible — return {"retake":true}.
- If there is a person in the frame — return {"person_detected":true}.
- If a reference photo is provided — count the stray objects on it too (reference_count): this family has its own idea of order, and it outranks the general bar.
${outputLangRule('praise, label, todo')}`;

export async function verify({ imageBefore, imageAfter, task, referenceUrl, beforeCount = null }) {
  const content = [];
  if (imageBefore) { content.push({ type: 'text', text: 'BEFORE photo:' }, dataUrl(imageBefore)); }
  content.push({ type: 'text', text: 'AFTER photo:' }, dataUrl(imageAfter));
  if (referenceUrl) { content.push({ type: 'text', text: 'Reference photo (how it should look when tidy):' }, { type: 'image_url', image_url: { url: referenceUrl, detail: 'high' } }); }
  // Сколько лишнего было до уборки, мы уже знаем от сканера — подсказываем,
  // чтобы модель не пересчитывала «до» на глаз и сравнивала с тем же числом,
  // по которому ребёнку ставили задачи.
  content.push({ type: 'text', text: [
    `The task was: ${task || 'tidy the surface'}.`,
    beforeCount ? `Before the tidy-up the scanner counted roughly ${beforeCount} stray objects on this surface.` : '',
    'Count what is stray on both photos, draw boxes around what is left, and return JSON.',
  ].filter(Boolean).join(' ') });
  return jsonCall(
    { model: MODEL, max_tokens: 900, temperature: 0,
      messages: [{ role: 'system', content: verifySystem() }, { role: 'user', content }] },
    sanitizeVerify,
    // Ответ без чисел и без списка судить не по чему — просим ещё раз.
    (o) => o.status === 'unclear',
  );
}

// ── Бонусное задание: ребёнок показывает САМО действие ──────────────────────
// Здесь всё наоборот по сравнению с /verify: человек в кадре — не ошибка, а суть
// снимка. Проверяем ровно одно — видно ли то, о чём просили. Сомневаешься —
// засчитывай: цена ложного «нет» (ребёнок реально вытер пыль, а ему не поверили)
// намного выше цены ложного «да».
const bonusSystem = (task) => `You are a kind assistant in a children's app about tidying up. The child has done an extra task and sent a photo as proof. Return ONLY JSON:
{"done":true,"praise":"Not a speck of dust left!","hint":""}

The task was: "${task.title}" — ${task.hint}
The photo should show: ${task.check}

Rules:
- The child, their hand or their face in the frame IS NORMAL and expected. Do not treat it as a mistake.
- done:true if the photo shows what was asked for, even roughly.
- When in doubt, set done:true. A 7-year-old photographs as best they can.
- done:false only when the photo is obviously the wrong task (asked for a cloth on
  the desk, sent a photo of the cat). Then put one short, kind hint in "hint"
  saying what to re-shoot.
- praise — a short lively compliment about how much cleaner it is now. No criticism.
${outputLangRule('praise, hint')}`;

export async function checkBonus(base64, task) {
  return jsonCall(
    { model: MODEL, max_tokens: 300, temperature: 0.2,
      messages: [
        { role: 'system', content: bonusSystem(task) },
        { role: 'user', content: [dataUrl(base64), { type: 'text', text: 'Here is the photo. Judge the task by the rules and return JSON.' }] },
      ] },
    sanitizeBonus,
    () => false, // любой разобранный ответ приемлем
  );
}

// ── §327 — одна живая фраза персонажа под то, что реально произошло ──────────
export async function reward(context) {
  const content = await chat({
    model: MODEL, max_tokens: 80, temperature: 0.9,
    messages: [
      { role: 'system', content: `You are a cheerful sidekick character in a children's app about tidying up. Reply with ONE short, lively phrase about what just happened, written in ${outputLang()}. No quotation marks, no criticism, only warmth and excitement.` },
      { role: 'user', content: `What happened: ${typeof context === 'string' ? context : JSON.stringify(context)}` },
    ],
  });
  return String(content || '').trim().replace(/^["'«]|["'»]$/g, '');
}
