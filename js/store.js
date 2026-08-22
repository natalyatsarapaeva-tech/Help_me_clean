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
  authReady,
} from './firebase.js';
import {
  makeFamilyId, makeJoinCode, normalizeJoinCode, pickActiveFamily,
  PARENT, CHILD, DEFAULT_THEME,
} from './family-core.js';
import {
  provisionChildDevice, hasChildDevice, unlockChildCredentials, clearChildDevice,
} from './child-auth.js';

export { normalizeJoinCode, hasChildDevice };

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
export async function provisionChildOnThisDevice(pin, email, password) {
  return provisionChildDevice(pin, email, password);
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
export async function createFamily(name) {
  const uid = currentUid();
  const fid = makeFamilyId(name);
  const now = new Date().toISOString();
  await setDoc(doc(db, 'families', fid), {
    name: name || 'Наш дом', ownerUid: uid, joinCode: makeJoinCode(), createdAt: now,
  });
  await setDoc(doc(db, 'families', fid, 'members', uid), { role: PARENT, addedBy: uid, joinedAt: now });
  await setDoc(doc(db, 'users', uid, 'families', fid), { role: PARENT, name: name || 'Наш дом', joinedAt: now });
  await setDoc(doc(db, 'families', fid, 'settings', 'app'), {
    playlists: { minion: '', jedi: '' }, dailyBudget: null,
  });
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
    theme: profile.theme || DEFAULT_THEME,
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
// Смена темы ребёнком (§49) — прогресс сохраняется, меняется оформление.
export async function setProfileTheme(fid, profileId, theme) {
  await setDoc(doc(db, 'families', fid, 'profiles', profileId), { theme }, { merge: true });
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
export async function getRewards(fid, profileId) {
  const snap = await getDoc(doc(db, 'families', fid, 'profiles', profileId, 'rewards', 'current'));
  return snap.exists() ? snap.data() : { currency: 0, cards: [], rank: null, cleanupsTotal: 0, realRewards: [] };
}
export async function saveRewards(fid, profileId, rewards) {
  await setDoc(doc(db, 'families', fid, 'profiles', profileId, 'rewards', 'current'), rewards, { merge: true });
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
