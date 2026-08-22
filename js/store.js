// Авторизация + доступ к данным семей (перенос Twin js/store.js под домен tidy).
// Двухуровневая модель «пользователь → семья», many-to-many:
//   users/{uid}                    — профиль {displayName, email, createdAt}
//   users/{uid}/families/{fid}     — индекс «мои семьи» {role, name, joinedAt}
//   families/{fid}                 — {name, ownerUid, joinCode, createdAt}
//   families/{fid}/members/{uid}   — источник прав {role, addedBy, joinedAt}
//   families/{fid}/profiles/{pid}  — профиль ребёнка (pid == uid), theme/avatar/route
//   families/{fid}/profiles/{pid}/progress/{sessionId}
//   families/{fid}/profiles/{pid}/rewards/current
//   families/{fid}/reference/{surfaceId}, /cards/{cardId}, /home/*, /settings/*
import {
  db, doc, getDoc, setDoc, collection, getDocs, query, where,
  auth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  authReady, createSecondaryAuth, projectId, deleteDoc,
  storage, storageRef, uploadBytes, getDownloadURL, deleteObject,
} from './firebase.js';

export { projectId };
import {
  makeFamilyId, makeJoinCode, normalizeJoinCode, pickActiveFamily,
  PARENT, CHILD, normalizeTheme, normalizeRewards, emptyRewards,
} from './family-core.js';
import {
  provisionChildDevice, hasChildDevice, unlockChildCredentials, clearChildDevice, childDeviceLabel,
} from './child-auth.js';

export { normalizeJoinCode, hasChildDevice, childDeviceLabel };

const ACTIVE_KEY = 'tidy.activeFamilyId';

let currentUser = null;
onAuthStateChanged(auth, user => { currentUser = user; });

let firstAuth = null;
export function initAuth() {
  if (!firstAuth) firstAuth = (async () => {
    try {
      const res = await getRedirectResult(auth);
      if (res?.user) { currentUser = res.user; await ensureUserDoc(); }
    } catch (e) { console.warn('getRedirectResult:', e?.code || e); }
    return await authReady;
  })();
  return firstAuth;
}

export function currentUid() { return currentUser?.uid || null; }
export function currentUserEmail() { return currentUser?.email || ''; }
export function currentUserName() { return currentUser?.displayName || ''; }

// ── Вход родителя ────────────────────────────────────────────────────────────
const POPUP_FALLBACK = new Set([
  'auth/popup-blocked', 'auth/cancelled-popup-request',
  'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported',
]);
export async function signInGoogle() {
  const provider = new GoogleAuthProvider();
  try {
    const cred = await signInWithPopup(auth, provider);
    currentUser = cred.user; await ensureUserDoc(); return cred;
  } catch (e) {
    if (POPUP_FALLBACK.has(e?.code)) { await signInWithRedirect(auth, provider); return null; }
    throw e;
  }
}
export async function signInEmail(email, pass) {
  const cred = await signInWithEmailAndPassword(auth, email, pass);
  currentUser = cred.user; await ensureUserDoc(); return cred;
}
export async function registerEmail(email, pass) {
  const cred = await createUserWithEmailAndPassword(auth, email, pass);
  currentUser = cred.user; await ensureUserDoc(); return cred;
}
export function signOutUser() { return signOut(auth); }

// ── Вход ребёнка по PIN (§137) ───────────────────────────────────────────────
// Планшет должен быть заранее провижен родителем (provisionChildOnThisDevice).
export async function signInChildWithPin(pin) {
  const { email, password } = await unlockChildCredentials(pin);
  return signInEmail(email, password);
}
// Родитель настраивает детский планшет: сохраняет учётку под PIN на устройстве.
// label = { name, avatar } — для экрана входа ребёнка (несекретно).
export async function provisionChildOnThisDevice(pin, email, password, label = {}) {
  return provisionChildDevice(pin, email, password, label);
}
export function forgetChildOnThisDevice() { clearChildDevice(); }

async function ensureUserDoc() {
  const uid = currentUid();
  if (!uid) return;
  try {
    const ref = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        displayName: currentUserName(), email: currentUserEmail(),
        createdAt: new Date().toISOString(),
      });
    }
  } catch (e) { console.warn('ensureUserDoc (проверь firestore.rules):', e?.code || e); }
}

// ── Мои семьи + активная ─────────────────────────────────────────────────────
export async function listMyFamilies() {
  const uid = currentUid();
  if (!uid) return [];
  const snap = await getDocs(collection(db, 'users', uid, 'families'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export function getActiveFamilyId() { return localStorage.getItem(ACTIVE_KEY); }
export function setActiveFamilyId(fid) { localStorage.setItem(ACTIVE_KEY, fid); }
export function resolveActiveFamily(families) {
  const active = pickActiveFamily(families, getActiveFamilyId());
  if (active) setActiveFamilyId(active);
  return active;
}

// ── Семья: создать / первый вход ─────────────────────────────────────────────
// Родитель регистрируется → авто-создаётся семья, он владелец, получает joinCode.
// Помечает ошибку шагом и путём — чтобы в консоли было видно, что именно
// запретили правила (permission-denied на конкретном документе).
async function at(step, path, promise) {
  try { return await promise; }
  catch (e) { console.error(`[createFamily] шаг «${step}» (${path}) →`, e?.code || e?.message || e); e.step = step; e.path = path; throw e; }
}
export async function createFamily(name) {
  const uid = currentUid();
  const fid = makeFamilyId(name);
  const now = new Date().toISOString();
  await at('семья', `families/${fid}`, setDoc(doc(db, 'families', fid), {
    name: name || 'Наш дом', ownerUid: uid, joinCode: makeJoinCode(), createdAt: now,
  }));
  await at('членство', `families/${fid}/members/${uid}`, setDoc(doc(db, 'families', fid, 'members', uid), { role: PARENT, addedBy: uid, joinedAt: now }));
  await at('индекс', `users/${uid}/families/${fid}`, setDoc(doc(db, 'users', uid, 'families', fid), { role: PARENT, name: name || 'Наш дом', joinedAt: now }));
  await at('настройки', `families/${fid}/settings/app`, setDoc(doc(db, 'families', fid, 'settings', 'app'), {
    playlists: { minion: '', jedi: '' }, dailyBudget: null,
  }));
  setActiveFamilyId(fid);
  return fid;
}
export async function ensureFirstFamily() {
  const mine = await listMyFamilies();
  if (mine.length) return resolveActiveFamily(mine);
  await createFamily('Наш дом');
  return getActiveFamilyId();
}
export async function getFamily(fid) {
  const snap = await getDoc(doc(db, 'families', fid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Присоединение второго ВЗРОСЛОГО по коду — через Worker (Admin SDK), не клиент:
// при закрытых правилах не-член не может ни прочитать семью по коду, ни записать
// себя в members. См. docs/AUTH-*.md, п.3.1. Клиент лишь отдаёт код + ID-token.
export async function joinFamilyByCode(rawCode, workerUrl) {
  const code = normalizeJoinCode(rawCode);
  if (code.length !== 6) return null;
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(`${workerUrl}/tidy/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) return null;
  const { familyId, name } = await res.json().catch(() => ({}));
  if (!familyId) return null;
  setActiveFamilyId(familyId);
  return { id: familyId, name };
}

// ── Профили детей (§392). profileId == uid ребёнка. ──────────────────────────
export async function listProfiles(fid) {
  const snap = await getDocs(collection(db, 'families', fid, 'profiles'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function getProfile(fid, profileId) {
  const snap = await getDoc(doc(db, 'families', fid, 'profiles', profileId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
// Родитель заводит профиль ребёнка (uid берётся из созданного Firebase-аккаунта).
export async function saveProfile(fid, profile) {
  const now = new Date().toISOString();
  const data = {
    uid: profile.uid,
    name: profile.name || '',
    // Тему родитель НЕ задаёт: ребёнок выбирает сам при входе («Кто ты сегодня?»).
    lastTheme: normalizeTheme(profile.lastTheme), // null, пока выбора не было
    avatar: profile.avatar || '',
    homeRoomId: profile.homeRoomId || null,
    routeOrder: Array.isArray(profile.routeOrder) ? profile.routeOrder : [],
    updatedAt: now,
    createdAt: profile.createdAt || now,
  };
  await setDoc(doc(db, 'families', fid, 'profiles', profile.uid), data, { merge: true });
  await setDoc(doc(db, 'families', fid, 'members', profile.uid), {
    role: CHILD, addedBy: currentUid(), joinedAt: now,
  }, { merge: true });
  return data;
}
// Ребёнок выбрал, кто он сегодня (§49). Запоминаем ТОЛЬКО как последний выбор:
// прогресс и валюта к теме не привязаны — меняются оформление и витрина коллекции.
export async function rememberChildTheme(fid, profileId, themeId) {
  const t = normalizeTheme(themeId);
  if (!t) return;
  await setDoc(doc(db, 'families', fid, 'profiles', profileId), {
    lastTheme: t, updatedAt: new Date().toISOString(),
  }, { merge: true });
}

// Служебный email/пароль детского аккаунта (§137). Email не подтверждается
// Firebase, пароль ребёнку неизвестен (§455) — он знает только PIN.
function childEmail(name) {
  const slug = String(name || 'kid').toLowerCase().replace(/[^a-z0-9]/gi, '') || 'kid';
  return `${slug}-${Math.random().toString(36).slice(2, 8)}@tidy.local`;
}
function randomPassword() {
  return Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(36)).join('').slice(0, 24);
}

// Родитель создаёт детский аккаунт: во ВТОРИЧНОМ Firebase-app (иначе создание
// перелогинит родителя), затем из основного инстанса пишет профиль + членство
// (правила это разрешают родителю). Возвращает { uid, email, password } —
// пароль показывается один раз, дальше живёт только зашифрованным на планшете.
export async function createChildAccount(fid, { name, theme, avatar }) {
  const email = childEmail(name);
  const password = randomPassword();
  const { auth: secAuth, destroy } = await createSecondaryAuth();
  try {
    const cred = await createUserWithEmailAndPassword(secAuth, email, password);
    const uid = cred.user.uid;
    await signOut(secAuth);
    await saveProfile(fid, { uid, name, theme, avatar });
    return { uid, email, password };
  } finally {
    await destroy();
  }
}

// ── Прогресс сессии уборки ───────────────────────────────────────────────────
export async function saveProgress(fid, profileId, session) {
  await setDoc(doc(db, 'families', fid, 'profiles', profileId, 'progress', session.id), session);
}
export async function listProgress(fid, profileId) {
  const snap = await getDocs(collection(db, 'families', fid, 'profiles', profileId, 'progress'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── Награды (§399) ────────────────────────────────────────────────────────────
// Валюта и счётчик уборок — на ребёнке; коллекция карточек — по темам
// (cardsByTheme). normalizeRewards заодно мигрирует старый плоский cards[].
export async function getRewards(fid, profileId) {
  const snap = await getDoc(doc(db, 'families', fid, 'profiles', profileId, 'rewards', 'current'));
  return snap.exists() ? normalizeRewards(snap.data()) : emptyRewards();
}
export async function saveRewards(fid, profileId, rewards) {
  await setDoc(doc(db, 'families', fid, 'profiles', profileId, 'rewards', 'current'), rewards, { merge: true });
}

// ── Эталонные фото (§300) ────────────────────────────────────────────────────
// Родитель один раз снимает «как должно выглядеть убранным»; проверка сравнивает
// «после» с эталоном, а не с идеалом из головы модели. Экрана загрузки пока нет —
// раунд просто работает без эталона, если документа нет.
export async function getReference(fid, surfaceId) {
  const snap = await getDoc(doc(db, 'families', fid, 'reference', surfaceId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
export async function listReferences(fid) {
  const snap = await getDocs(collection(db, 'families', fid, 'reference'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
function referencePath(fid, surfaceId) { return `families/${fid}/reference/${surfaceId}.jpg`; }

// Файл — в Storage (там место картинкам), ссылка и метаданные — в Firestore
// (оттуда их читает раунд). Одна поверхность — один файл: пересъёмка перезаписывает,
// история эталонов никому не нужна.
export async function saveReference(fid, surfaceId, blob, meta = {}) {
  const path = referencePath(fid, surfaceId);
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, blob, { contentType: 'image/jpeg' });
  const url = await getDownloadURL(fileRef);
  const data = {
    surfaceId,
    roomId: meta.roomId || surfaceId,
    roomName: meta.roomName || '',
    url, path,
    w: meta.w || null, h: meta.h || null,
    byUid: currentUid(),
    updatedAt: new Date().toISOString(),
  };
  await setDoc(doc(db, 'families', fid, 'reference', surfaceId), data, { merge: true });
  return { id: surfaceId, ...data };
}
export async function deleteReference(fid, surfaceId) {
  try { await deleteObject(storageRef(storage, referencePath(fid, surfaceId))); }
  catch (e) { if (e?.code !== 'storage/object-not-found') throw e; } // файла нет — документ всё равно чистим
  await deleteDoc(doc(db, 'families', fid, 'reference', surfaceId));
}

// ── Карточки коллекции (§336) ────────────────────────────────────────────────
// Каталог загружает РОДИТЕЛЬ (правила: /cards пишет только parent, читают все
// члены). Ребёнок карточки не создаёт — он их добывает: id добытых лежат в его
// наградах (cardsByTheme), а картинки берутся отсюда.
export async function listCards(fid) {
  const snap = await getDocs(collection(db, 'families', fid, 'cards'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
function cardPath(fid, cardId) { return `families/${fid}/cards/${cardId}.jpg`; }

export async function saveCard(fid, cardId, blob, meta = {}) {
  const path = cardPath(fid, cardId);
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, blob, { contentType: 'image/jpeg' });
  const url = await getDownloadURL(fileRef);
  const data = {
    name: meta.name || '',
    theme: meta.theme || 'any',
    url, path,
    w: meta.w || null, h: meta.h || null,
    byUid: currentUid(),
    createdAt: new Date().toISOString(),
  };
  await setDoc(doc(db, 'families', fid, 'cards', cardId), data, { merge: true });
  return { id: cardId, ...data };
}
// Удаление карточки из каталога НЕ трогает награды детей: добытое не отнимается
// (§336). Такая карточка просто пропадает с витрины (см. orphans в cards-core).
export async function deleteCard(fid, cardId) {
  try { await deleteObject(storageRef(storage, cardPath(fid, cardId))); }
  catch (e) { if (e?.code !== 'storage/object-not-found') throw e; }
  await deleteDoc(doc(db, 'families', fid, 'cards', cardId));
}

// ── Реальные награды (§317) ──────────────────────────────────────────────────
// Витрину заводит РОДИТЕЛЬ (правила: пишет parent, читают все члены).
// Покупка сюда не пишет: она меняет только награды самого ребёнка.
export async function listRealRewards(fid) {
  const snap = await getDocs(collection(db, 'families', fid, 'realRewards'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function saveRealReward(fid, rewardId, data) {
  const doc_ = {
    name: data.name || '', cost: Number(data.cost) || 0, emoji: data.emoji || '🎁',
    byUid: currentUid(), createdAt: data.createdAt || new Date().toISOString(),
  };
  await setDoc(doc(db, 'families', fid, 'realRewards', rewardId), doc_, { merge: true });
  return { id: rewardId, ...doc_ };
}
export async function deleteRealReward(fid, rewardId) {
  await deleteDoc(doc(db, 'families', fid, 'realRewards', rewardId));
}

// Родителю — награды всех детей сразу: очередь «что купили и надо выдать».
export async function listAllRewards(fid) {
  const profiles = await listProfiles(fid);
  return Promise.all(profiles.map(async p => ({
    profile: p,
    rewards: await getRewards(fid, p.id).catch(() => emptyRewards()),
  })));
}

// ── Дом и настройки ──────────────────────────────────────────────────────────
export async function getHome(fid) {
  const snap = await getDoc(doc(db, 'families', fid, 'home', 'map'));
  return snap.exists() ? snap.data() : null;
}
export async function saveHome(fid, home) {
  await setDoc(doc(db, 'families', fid, 'home', 'map'), home, { merge: true });
}
export async function getSettings(fid) {
  const snap = await getDoc(doc(db, 'families', fid, 'settings', 'app'));
  return snap.exists() ? snap.data() : null;
}
export async function saveSettings(fid, settings) {
  await setDoc(doc(db, 'families', fid, 'settings', 'app'), settings, { merge: true });
}
