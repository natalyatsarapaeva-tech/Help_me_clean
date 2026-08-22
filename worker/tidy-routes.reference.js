// РЕФЕРЕНС маршрутов Worker для «Наведи и убери» (НЕ задеплоен как есть —
// добавляется в существующий воркер Twin). Показывает форму запросов/ответов и
// ключевую идею: join-по-коду делает сервер (Admin SDK), а не клиент.
//
// Почему join на сервере (docs/AUTH-i-pereispolzovanie.md, п.3.1): при закрытых
// Firestore-правилах не-член не может ни прочитать семью по коду, ни записать
// себя в members. Клиент присылает только код + свой ID-token; воркер проверяет
// токен, находит семью по коду и с admin-правами пишет membership.
//
// Секрет LLM (OPENAI_API_KEY / ключ vision-модели) — в env воркера, не в браузере.
// Лимиты — по заголовку X-Device-Id (§174). Origin-allowlist — как в воркере Twin.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    // ── Присоединение по коду (второй взрослый) ──
    if (url.pathname === '/tidy/join' && request.method === 'POST') {
      const uid = await verifyIdToken(request, env);           // Firebase Admin: проверить Bearer-token
      if (!uid) return json({ error: 'unauthorized' }, 401);
      const { code } = await request.json();
      const family = await findFamilyByJoinCode(env, code);    // admin-чтение families where joinCode==code
      if (!family) return json({ error: 'code-not-found' }, 404);
      await adminWriteMembership(env, family.id, uid);         // members/{uid} + users/{uid}/families/{fid} = child? нет — parent
      return json({ familyId: family.id, name: family.name });
    }

    // ── Проксирование LLM-запросов (ключ на сервере) ──
    const routes = {
      '/tidy/parse-home': parseHomePrompt,
      '/tidy/scan':       scanPrompt,
      '/tidy/verify':     verifyPrompt,
      '/tidy/reward':     rewardPrompt,
    };
    const build = routes[url.pathname];
    if (build && request.method === 'POST') {
      const deviceId = request.headers.get('X-Device-Id') || 'unknown';
      if (await overBudget(env, deviceId)) return json({ error: 'budget-exceeded' }, 429); // §176
      const payload = build(await request.json());             // собрать messages под нужную JSON-схему
      const out = await callVisionModel(env, payload);         // §442: при невалидном JSON — один повтор здесь
      return json(out);
    }

    if (url.pathname === '/tidy/health') return json(await budgetStatus(env, request.headers.get('X-Device-Id')));
    return json({ error: 'not-found' }, 404);
  },
};

function json(obj, status = 200) { return cors(new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS })); }
function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*'); // сузить до Origin-allowlist воркера Twin
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');
  res.headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  return res;
}

// ── Заглушки: реализуются через firebase-admin и клиент vision-модели ────────
async function verifyIdToken(request, env) { /* admin.auth().verifyIdToken(bearer) → uid */ return null; }
async function findFamilyByJoinCode(env, code) { /* admin Firestore query */ return null; }
async function adminWriteMembership(env, fid, uid) { /* batch: members/{uid}=parent + users/{uid}/families/{fid} */ }
async function overBudget(env, deviceId) { return false; }
async function budgetStatus(env, deviceId) { return { remaining: null }; }
async function callVisionModel(env, payload) { return {}; }

// Промпты возвращают payload для vision-модели. Требования §442/§294/§210:
// строго JSON по схеме, категории/типы — из закрытых списков, оценка мягкая.
function parseHomePrompt(body) { /* text → {floors:[{name,rooms:[{id,name,type,icon,surfaces,typical_clutter}]}]} */ return {}; }
function scanPrompt(body) { /* image,mode,roomType → closeup:{items,groups} | overview:{route,estimated_minutes} */ return {}; }
function verifyPrompt(body) { /* imageBefore,imageAfter,task,referenceUrl → {done,score,praise,missed,person_detected,retake} */ return {}; }
function rewardPrompt(body) { /* context → {phrase} */ return {}; }
