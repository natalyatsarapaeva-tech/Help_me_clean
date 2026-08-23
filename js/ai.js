// Вызовы LLM с vision через СУЩЕСТВУЮЩИЙ тонкий прокси Worker `/ai` (путь B1).
// Воркер не меняем: он принимает payload OpenAI chat completions и возвращает
// ответ OpenAI (ключ на стороне воркера). Промпты и разбор — на клиенте, ровно
// как в twin-things js/ai.js. Origin github.io уже в allow-list воркера.
//
// §442: строгая JSON-схема → один повтор при невалидном ответе → санитайз.
// Санитайзеры (sanitizeScan/Verify/Home) — в family-core.js (чистые, тестируемые).
import {
  ACTION_CATEGORIES, ACTION_IDS, ROOM_TYPES, roomTypeLabel, TIDY_STANDARD_TEXT,
  VERIFY_LIMITS_TEXT, SEEN_TAGS_TEXT,
  sanitizeScan, sanitizeVerify, sanitizeBonus, sanitizeHome, parseJsonObject,
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

// ── §223/§268 — стоп-кадр → подсветка предметов (closeup) или очаги (overview) ─
const colorDict = () => ACTION_CATEGORIES
  .map(c => `${c.id} — ${c.instruction} (${c.target})`).join('\n')
  + `

Уточнения по категориям:
- textile — ВСЁ тканевое: одежда, полотенца, тряпки, носки, бельё, коврики.
  Не решай, чистое оно или грязное.
- floor — то, чему не место НА ПОЛУ, даже если вещь нужная: коробки, ящики,
  пакеты и сумки, провода и удлинители, стопки вещей у стены.
- make_bed — незаправленная кровать (смятое одеяло, сбитое бельё). Один объект
  на всю кровать, box — по кровати целиком. Заправленную кровать не трогай.
- bin_full — ПОЛНАЯ или заметно наполненная урна/корзина для бумаг в кадре.
  Ровно один такой объект на комнату. Пустую урну не добавляй.
- belongs_elsewhere — вещь на своём месте не находится, но и категории выше не
  подходят: она живёт в другой комнате.`;

// Имя предмета для ребёнка: конкретное, если видно, общее — если нет.
const LABEL_RULE = `- label — как вещь назвал бы ребёнок. Если понятно, что это —
  называй конкретно («джинсы», «носки», «кружка»); если не понятно — общим
  словом («полотенце», «тряпка», «коробка»). Не выдумывай подробностей.`;

// Норма порядка — общая для сканера и проверки (family-core.TIDY_STANDARD).
const standard = () => `Что считается убранным:\n${TIDY_STANDARD_TEXT}`;

// Контекст для бонусных заданий: «полей цветок» имеет смысл там, где цветок
// есть. Спрашиваем тем же вызовом, что ищет работу, — отдельный вызов ИИ ради
// одного списка не окупается.
const seenRule = () => `- seen — что ЕЩЁ есть в кадре из этого списка (ничего из списка нет — пустой список):
${SEEN_TAGS_TEXT}`;

// Место в кадре — ключ дневного лимита: одна и та же раковина не должна
// приносить награду бесконечно, но другой угол той же комнаты — должен.
const placeRule = (surfaces) => `- place — КОРОТКОЕ название места, которое снято
  (2–3 слова, без предлогов): «раковина», «стол у окна», «пол у двери».${
  surfaces?.length ? `\n  Если подходит что-то из списка поверхностей этой комнаты — возьми ОТТУДА
  дословно: ${surfaces.join(', ')}.` : ''}
  Одно и то же место на разных фото называй ОДИНАКОВО.`;

function scanSystem(mode, surfaces) {
  const dict = colorDict();
  const places = placeRule(surfaces);
  if (mode === 'overview') {
    return `Ты помощник по уборке. На фото — комната целиком. Раздели работу на ОЧАГИ беспорядка (зоны) — так, как их назвал бы человек, зашедший в комнату: «одежда на стуле», «коробки на полу», «стол завален», «полная урна». НЕ перечисляй отдельные вещи: очаг — это место, а не предмет. Верни ТОЛЬКО JSON:
{"mode":"overview","place":"детская","zones":[{"id":1,"kind":"chair","label":"одежда на стуле","point":[0.22,0.55],"category":"textile","action":"убери одежду со стула","items_estimate":3,"needs_closeup":false},{"id":2,"kind":"desk","label":"письменный стол","point":[0.61,0.42],"category":"paper","action":"наведи порядок на столе","items_estimate":9,"needs_closeup":true}],"seen":["plant"],"estimated_minutes":12}

${standard()}

Правила:
- От 2 до 7 очагов. Меньше двух — только если комната почти убрана. Однотипное рядом (три коробки у стены) — ОДИН очаг, а не три.
- kind — РОВНО ОДИН из: chair (вещи на стуле или кресле), floor (то, что лежит на полу), bed (незаправленная кровать), desk (стол, письменный или журнальный), shelf (полка, стеллаж), surface (тумба, подоконник, комод), bin (полная урна), other (всё прочее).
- category — действие с этим очагом, РОВНО ОДИН id из списка ниже, не выдумывай:
${dict}
- label — как назвал бы это место ребёнок: «одежда на стуле», «коробки у шкафа», «стол».
- action — что именно сделать, короткой фразой ребёнку: «убери одежду со стула», «отнеси коробки в шкаф».
- items_estimate — сколько примерно вещей в этом очаге (числом).
${places}
- point — [x,y] центра очага в долях кадра 0..1 (x слева направо, y сверху вниз).
${seenRule()}
- needs_closeup — true, если с этой точки ВИДНО, что там беспорядок, но НЕ РАЗГЛЯДЕТЬ, что именно: мелочь на столе, заваленная полка. Тогда ребёнок подойдёт и снимет крупным планом. Для стула с одеждой, коробок на полу, кровати и урны — false: там и так всё понятно.
- estimated_minutes — сколько примерно минут займёт вся комната.
- Если человек в кадре — верни {"person_detected":true}.`;
  }
  return `Ты помощник по уборке. На фото — стол/полка/поверхность крупным планом. Найди ВСЁ, что мешает поверхности быть убранной по норме ниже, и отнеси каждый предмет к ОДНОЙ категории действия. Верни ТОЛЬКО JSON:
{"mode":"closeup","place":"раковина","items":[{"id":1,"label":"тетрадь","category":"paper","box":[0.12,0.34,0.28,0.51],"confidence":0.86}],"seen":["plant"],"surface_state":"messy"}

${standard()}

Правила:
- category — РОВНО ОДИН id из списка ниже, не выдумывай:
${dict}
${LABEL_RULE}
${places}
- box — прямоугольник вокруг предмета в НОРМАЛИЗОВАННЫХ углах [x1,y1,x2,y2] (верхний-левый и нижний-правый), каждое число 0..1.
- Не выдумывай предметов, которых нет. Один предмет — один объект.
${seenRule()}
- Если человек в кадре — верни {"person_detected":true}.`;
}

export async function scan(base64, { mode = 'closeup', roomType, roomName, surfaces, zone } = {}) {
  // zone — крупный план внутри обхода комнаты: снят конкретный очаг («стол»),
  // и модель не должна уезжать на фон и размечать пол за столом.
  const hint = `Комната: ${roomName || '—'}${roomType ? ` (тип: ${roomType})` : ''}.${
    zone ? ` На фото крупным планом: ${zone}. Размечай только это место, фон не трогай.` : ''
  } Определи предметы и верни JSON по схеме.`;
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
const verifySystem = `Ты добрый помощник, который проверяет уборку у ребёнка 7 лет. Ты СЧИТАЕШЬ предметы на двух фото одной и той же поверхности — «до» и «после» — и показываешь, что осталось. Верни ТОЛЬКО JSON:
{"before_count":10,"after_count":4,"score":"good","praise":"Да ты почти у цели!","left":[{"label":"бумажки","count":3,"category":"trash","todo":"выбросить три бумажки"},{"label":"кружка","count":1,"category":"dishes","todo":"отнести посуду на место"}],"boxes":[{"label":"бумажка","box":[0.12,0.34,0.19,0.41]}]}

Что считается убранным:
${TIDY_STANDARD_TEXT}

Планка (по ней решают, засчитана уборка):
${VERIFY_LIMITS_TEXT}

Правила:
- СНАЧАЛА посчитай лишние предметы на фото ДО (before_count), потом на фото ПОСЛЕ (after_count). Числа обязательны — по ним считается результат.
- Лишнее — всё, что лежит на поверхности сверх нормы выше. Мебель, технику, лампу и ОДНУ стопку бумаг на письменном столе не считай.
- Кадры могут быть сняты с разного расстояния и угла: сравнивай, что ЛЕЖИТ на поверхности, а не как выглядит фото.
- Если «после» ничем не отличается от «до» — так и посчитай: after_count будет равен before_count. Не занижай из вежливости, это не помощь ребёнку.
- left — что осталось, сгруппированное по видам, с количеством. Пусто на поверхности — верни "left": [] и "after_count": 0.
- category — РОВНО ОДИН id: ${ACTION_IDS.join(', ')}.
- todo — готовая фраза, что с этим сделать, в неопределённой форме и с числительным словами: «выбросить три бумажки», «отнести посуду на место», «повесить кофту».
- boxes — рамка вокруг КАЖДОГО оставшегося лишнего предмета на фото ПОСЛЕ, в нормализованных углах [x1,y1,x2,y2] (0..1). До 12 штук. Ребёнок увидит их прямо на своём фото — без них он не поймёт, что именно убирать.
- Засчитано или нет — решает приложение по числам, тебе про это думать не надо. Поле "done" не возвращай.
- praise — короткая живая фраза по-русски. Осталось лишнее — подбадривай и не сдавайся: «Да ты почти у цели!», «Ух, как стало просторно! Ещё чуть-чуть». Убрано — искренне порадуйся результату.
- НИКОГДА не критикуй самого ребёнка и не называй его неряхой: говори только о предметах.
- score — one of: great | good | ok.
- Если фото ПОСЛЕ снято не той поверхности или так, что поверхности не видно — верни {"retake":true}.
- Если в кадре человек — верни {"person_detected":true}.
- Если дан эталон — посчитай лишние предметы и на нём (reference_count): у этой семьи свой порядок, и он важнее общей планки.`;

export async function verify({ imageBefore, imageAfter, task, referenceUrl, beforeCount = null }) {
  const content = [];
  if (imageBefore) { content.push({ type: 'text', text: 'Фото ДО:' }, dataUrl(imageBefore)); }
  content.push({ type: 'text', text: 'Фото ПОСЛЕ:' }, dataUrl(imageAfter));
  if (referenceUrl) { content.push({ type: 'text', text: 'Эталон (как должно выглядеть убранным):' }, { type: 'image_url', image_url: { url: referenceUrl, detail: 'high' } }); }
  // Сколько лишнего было до уборки, мы уже знаем от сканера — подсказываем,
  // чтобы модель не пересчитывала «до» на глаз и сравнивала с тем же числом,
  // по которому ребёнку ставили задачи.
  content.push({ type: 'text', text: [
    `Задание было: ${task || 'убрать поверхность'}.`,
    beforeCount ? `Сканер до уборки насчитал на этой поверхности примерно ${beforeCount} лишних предметов.` : '',
    'Посчитай лишнее на обоих фото, обведи то, что осталось, и верни JSON.',
  ].filter(Boolean).join(' ') });
  return jsonCall(
    { model: MODEL, max_tokens: 900, temperature: 0,
      messages: [{ role: 'system', content: verifySystem }, { role: 'user', content }] },
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
const bonusSystem = (task) => `Ты добрый помощник в детском приложении про уборку. Ребёнок выполнил дополнительное задание и прислал фото-доказательство. Верни ТОЛЬКО JSON:
{"done":true,"praise":"Пыли как не бывало!","hint":""}

Задание было: «${task.title}» — ${task.hint}
На фото должно быть видно: ${task.check}

Правила:
- Ребёнок, его рука, лицо в кадре — ЭТО НОРМАЛЬНО и ожидаемо. Не считай это ошибкой.
- done:true, если на фото видно то, о чём просили, хотя бы в общих чертах.
- Сомневаешься — ставь done:true. Ребёнок 7 лет снимает как умеет.
- done:false только если на фото очевидно НЕ то задание (например, просили тряпку
  на столе, а прислали фото кота). Тогда в hint — одна короткая добрая подсказка,
  что доснять.
- praise — короткая живая похвала по-русски, про то, что стало чище. Без критики.`;

export async function checkBonus(base64, task) {
  return jsonCall(
    { model: MODEL, max_tokens: 300, temperature: 0.2,
      messages: [
        { role: 'system', content: bonusSystem(task) },
        { role: 'user', content: [dataUrl(base64), { type: 'text', text: 'Вот фото. Засчитай задание по правилам и верни JSON.' }] },
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
      { role: 'system', content: 'Ты весёлый персонаж-помощник в детском приложении про уборку. Ответь ОДНОЙ короткой живой фразой по-русски под то, что произошло. Без кавычек, без критики, только позитив и азарт.' },
      { role: 'user', content: `Что произошло: ${typeof context === 'string' ? context : JSON.stringify(context)}` },
    ],
  });
  return String(content || '').trim().replace(/^["'«]|["'»]$/g, '');
}
