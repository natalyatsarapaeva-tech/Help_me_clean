// Авторизация + доступ к данным семей (перенос Twin js/store.js под домен tidy).
// Двухуровневая модель «пользователь → семья», many-to-many:
//   users/{uid}                    — профиль {displayName, email, createdAt}
//   users/{uid}/families/{fid}     — индекс «мои семьи» {role, name, joinedAt}
//   families/{fid}                 — {name, ownerUid, joinCode, createdAt}
//   families/{fid}/members/{uid}   — источник прав {role, addedBy, joinedAt}
//   families/{fid}/profiles/{pid}  — профиль ребёнка (документ, НЕ пользователь):
//                                     name/avatar/lastTheme/route + PIN-замок (хэш)
//   families/{fid}/profiles/{pid}/progress/{sessionId}
//   families/{fid}/profiles/{pid}/rewards/current
//   families/{fid}/profiles/{pid}/tasks/{taskId}  — ход выполнения задания
//   families/{fid}/reference/{surfaceId}, /cards/{cardId}, /tasks/{taskId}, /home/*, /settings/*
//   families/{fid}/settings/app    — язык, темы семьи, PIN родителя, проверка по фото
import {
  db, doc, getDoc, setDoc, collection, getDocs, query, where, writeBatch,
  auth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  authReady, projectId, deleteDoc,
  storage, storageRef, uploadBytes, getDownloadURL, deleteObject,
} from './firebase.js';

export { projectId };
import {
  makeFamilyId, makeJoinCode, normalizeJoinCode, pickActiveFamily,
  PARENT, normalizeTheme, normalizeRewards, emptyRewards, setFamilyThemes,
} from './family-core.js';
import { normalizeThemes, defaultThemes } from './themes-core.js';
import { makeProfileId, normalizeProfiles, pickActiveProfile } from './profile-core.js';
import { hashPin } from './pin.js';
import { t, getLang, normalizeLang, adoptFamilyLang } from './i18n.js';

export { normalizeJoinCode };

const ACTIVE_KEY = 'tidy.activeFamilyId';
const PROFILE_KEY = 'tidy.activeProfileId';

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

// Вход в приложение — ТОЛЬКО родительский: планшет становится семейным
// устройством, а дети выбирают себя на экране профилей (см. profile-core.js).
// Служебных детских аккаунтов больше нет.

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
  } catch (e) { console.warn('ensureUserDoc (check firestore.rules):', e?.code || e); }
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

// ── Кто сейчас убирается на этом устройстве ──────────────────────────────────
// Выбор живёт в localStorage: переживает перезагрузку и переходы между
// экранами, чтобы ребёнок не набирал PIN на каждой странице.
export function getActiveProfileId() { return localStorage.getItem(PROFILE_KEY); }
export function setActiveProfileId(pid) { localStorage.setItem(PROFILE_KEY, pid); }
export function clearActiveProfileId() { localStorage.removeItem(PROFILE_KEY); }
export function resolveActiveProfile(profiles) {
  const active = pickActiveProfile(profiles, getActiveProfileId());
  if (!active) clearActiveProfileId();
  return active;
}

// Родительская часть открыта до перезапуска приложения: набирать PIN на каждом
// экране — наказание для родителя. sessionStorage, а не localStorage: закрыл
// приложение и отдал планшет ребёнку — замок снова на месте.
const PARENT_KEY = 'tidy.parentUnlocked';
export function isParentUnlocked() { return sessionStorage.getItem(PARENT_KEY) === '1'; }
export function unlockParentArea() { sessionStorage.setItem(PARENT_KEY, '1'); }
export function lockParentArea() { sessionStorage.removeItem(PARENT_KEY); }

// ── Семья: создать / первый вход ─────────────────────────────────────────────
// Родитель регистрируется → авто-создаётся семья, он владелец, получает joinCode.
// Помечает ошибку шагом и путём — чтобы в консоли было видно, что именно
// запретили правила (permission-denied на конкретном документе).
async function at(step, path, promise) {
  try { return await promise; }
  catch (e) { console.error(`[createFamily] step "${step}" (${path}) →`, e?.code || e?.message || e); e.step = step; e.path = path; throw e; }
}
export async function createFamily(name) {
  const uid = currentUid();
  const fid = makeFamilyId(name);
  const now = new Date().toISOString();
  await at('family', `families/${fid}`, setDoc(doc(db, 'families', fid), {
    name: name || t('parent.defaultFamily'), ownerUid: uid, joinCode: makeJoinCode(), createdAt: now,
  }));
  await at('membership', `families/${fid}/members/${uid}`, setDoc(doc(db, 'families', fid, 'members', uid), { role: PARENT, addedBy: uid, joinedAt: now }));
  await at('index', `users/${uid}/families/${fid}`, setDoc(doc(db, 'users', uid, 'families', fid), { role: PARENT, name: name || t('parent.defaultFamily'), joinedAt: now }));
  await at('settings', `families/${fid}/settings/app`, setDoc(doc(db, 'families', fid, 'settings', 'app'), {
    // Темы-пресеты кладём сразу: родителю есть что переименовать под интересы
    // ребёнка, а ребёнку есть из чего выбрать образ до первой настройки.
    themes: defaultThemes(), photoCheckRequired: true,
    playlists: {}, dailyBudget: null, lang: getLang(),
  }));
  setActiveFamilyId(fid);
  return fid;
}
export async function ensureFirstFamily() {
  const mine = await listMyFamilies();
  if (mine.length) return resolveActiveFamily(mine);
  await createFamily(t('parent.defaultFamily'));
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

// ── Профили детей. Профиль — ДОКУМЕНТ, а не пользователь Firebase. ───────────
// У старых профилей id совпадает с uid прежнего служебного аккаунта — это
// неважно и ничего не ломает: прогресс и награды привязаны к id.
export async function listProfiles(fid) {
  const snap = await getDocs(collection(db, 'families', fid, 'profiles'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function getProfile(fid, profileId) {
  const snap = await getDoc(doc(db, 'families', fid, 'profiles', profileId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
// Родитель заводит или правит профиль ребёнка. Никаких аккаунтов и паролей.
export async function saveProfile(fid, profile) {
  const now = new Date().toISOString();
  const id = profile.id || makeProfileId(profile.name);
  const data = {
    name: profile.name || '',
    // Тему родитель НЕ задаёт: ребёнок выбирает сам при входе («Кто ты сегодня?»).
    lastTheme: normalizeTheme(profile.lastTheme), // null, пока выбора не было
    avatar: profile.avatar || '🧒',
    homeRoomId: profile.homeRoomId || null,
    routeOrder: Array.isArray(profile.routeOrder) ? profile.routeOrder : [],
    updatedAt: now,
    createdAt: profile.createdAt || now,
  };
  await setDoc(doc(db, 'families', fid, 'profiles', id), data, { merge: true });
  return { id, ...data };
}

// PIN профиля: в базу уходит только хэш с солью (js/pin.js). Пустой PIN снимает
// замок — профиль малыша, который цифры ещё не помнит, открыт.
export async function setProfilePin(fid, profileId, pin) {
  const lock = pin ? await hashPin(pin) : null;
  await setDoc(doc(db, 'families', fid, 'profiles', profileId), {
    pin: lock, updatedAt: new Date().toISOString(),
  }, { merge: true });
  return lock;
}
export async function deleteProfile(fid, profileId) {
  await deleteDoc(doc(db, 'families', fid, 'profiles', profileId));
  if (getActiveProfileId() === profileId) clearActiveProfileId();
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

// Родитель добавляет ребёнка: один документ и (по желанию) PIN. Ни служебного
// email, ни пароля, ни «показать один раз» — добавить ребёнка на втором планшете
// теперь означает просто войти на нём родителем.
export async function createChildProfile(fid, { name, avatar, pin }) {
  const profile = await saveProfile(fid, { id: makeProfileId(name), name, avatar });
  if (pin) await setProfilePin(fid, profile.id, pin);
  return profile;
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
function rewardPhotoPath(fid, rewardId) { return `families/${fid}/rewards/${rewardId}.jpg`; }

// blob — фото награды (необязательно): настоящее мороженое из соседнего кафе
// мотивирует сильнее эмодзи. Файл в Storage, ссылка в документе — как у
// карточек и эталонов. Одна награда — один файл, замена перезаписывает.
export async function saveRealReward(fid, rewardId, data, blob = null) {
  const doc_ = {
    name: data.name || '', cost: Number(data.cost) || 0, emoji: data.emoji || '🎁',
    byUid: currentUid(), createdAt: data.createdAt || new Date().toISOString(),
  };
  if (blob) {
    const path = rewardPhotoPath(fid, rewardId);
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, blob, { contentType: 'image/jpeg' });
    doc_.url = await getDownloadURL(fileRef);
    doc_.path = path;
    doc_.w = data.w || null;
    doc_.h = data.h || null;
  }
  await setDoc(doc(db, 'families', fid, 'realRewards', rewardId), doc_, { merge: true });
  return { id: rewardId, ...doc_ };
}
// Убрали награду с витрины — уносим и файл: место в Storage платное, а
// ссылка на него больше ниоткуда не читается. Уже купленное у детей остаётся
// (там своя копия названия и ссылки), но картинка пропадёт — это честно:
// награды больше нет.
export async function deleteRealReward(fid, rewardId) {
  try { await deleteObject(storageRef(storage, rewardPhotoPath(fid, rewardId))); }
  catch (e) { if (e?.code !== 'storage/object-not-found') throw e; }
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

// ── Задания от родителя: текст, цена и исполнитель ───────────────────────────
// Задание пишет РОДИТЕЛЬ (families/{fid}/tasks — правила те же, что у витрины
// наград), а ход выполнения лежит в поддереве ребёнка: туда ему открыт доступ,
// в каталог заданий — нет. Оба документа читает и тот, и другой.
export async function listTasks(fid) {
  const snap = await getDocs(collection(db, 'families', fid, 'tasks'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function saveTask(fid, taskId, data) {
  const doc_ = {
    title: data.title || '',
    note: data.note || '',
    cost: Number(data.cost) || 0,
    profileId: data.profileId || '',
    roomId: data.roomId || null,
    roomName: data.roomName || '',
    byUid: currentUid(),
    createdAt: data.createdAt || new Date().toISOString(),
  };
  await setDoc(doc(db, 'families', fid, 'tasks', taskId), doc_, { merge: true });
  return { id: taskId, ...doc_ };
}
// Фото отчёта — в Storage, рядом с эталонами и карточками (правила выданы на
// families/{fid}/**). Одно задание — один исполнитель и одно фото: пересъёмка
// перезаписывает файл, галерея попыток никому не нужна.
function taskPhotoPath(fid, taskId) { return `families/${fid}/tasks/${taskId}.jpg`; }

export async function uploadTaskPhoto(fid, taskId, blob, meta = {}) {
  const path = taskPhotoPath(fid, taskId);
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, blob, { contentType: 'image/jpeg' });
  return { url: await getDownloadURL(fileRef), path, w: meta.w || null, h: meta.h || null };
}

export async function listTaskRuns(fid, profileId) {
  const snap = await getDocs(collection(db, 'families', fid, 'profiles', profileId, 'tasks'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function saveTaskRun(fid, profileId, taskId, run) {
  await setDoc(doc(db, 'families', fid, 'profiles', profileId, 'tasks', taskId), { ...run, taskId }, { merge: true });
}
// «Засчитать» — ДВЕ записи: отметка на задании и искорки в наградах ребёнка.
// Порознь их писать нельзя: упади сеть между ними — либо родитель видит
// незасчитанное задание и платит второй раз, либо задание закрыто, а искорок
// нет и никто об этом не узнает. Батч коммитится целиком или никак.
export async function commitTaskDecision(fid, profileId, taskId, run, rewards = null) {
  const batch = writeBatch(db);
  batch.set(doc(db, 'families', fid, 'profiles', profileId, 'tasks', taskId), { ...run, taskId }, { merge: true });
  if (rewards) batch.set(doc(db, 'families', fid, 'profiles', profileId, 'rewards', 'current'), rewards, { merge: true });
  await batch.commit();
}
// Удаляя задание, уносим и файл, и запись у ребёнка: иначе в его «Входящих»
// осталась бы строка без задания. Начисленные искорки при этом не отнимаются —
// добытое не отбирают (§336).
export async function deleteTask(fid, taskId, profileId) {
  try { await deleteObject(storageRef(storage, taskPhotoPath(fid, taskId))); }
  catch (e) { if (e?.code !== 'storage/object-not-found') throw e; }
  if (profileId) {
    await deleteDoc(doc(db, 'families', fid, 'profiles', profileId, 'tasks', taskId)).catch(e => console.warn('task run:', e));
  }
  await deleteDoc(doc(db, 'families', fid, 'tasks', taskId));
}
// Родителю — ход выполнения по всем детям сразу: из этого собирается очередь
// проверки (та же форма, что у listAllRewards).
export async function listAllTaskRuns(fid) {
  const profiles = await listProfiles(fid);
  return Promise.all(profiles.map(async p => ({
    profile: p,
    runs: await listTaskRuns(fid, p.id).catch(() => []),
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
// Родительский PIN — замок на «взрослой» части (дом, дети, карточки, награды).
// Лежит в настройках семьи: правила разрешают писать туда только родителю.
export async function setParentPin(fid, pin) {
  const lock = pin ? await hashPin(pin) : null;
  await setDoc(doc(db, 'families', fid, 'settings', 'app'), { parentPin: lock }, { merge: true });
  return lock;
}

// Язык семьи хранится рядом с остальными настройками (families/{fid}/settings/app).
// Устройство всё равно решает само (js/i18n.js): свой сохранённый выбор сильнее.
// Смысл поля — чтобы ВТОРОЙ планшет, на котором язык ещё не выбирали, открылся
// сразу на языке семьи, а не на английском по умолчанию.
export async function setFamilyLang(fid, lang) {
  const l = normalizeLang(lang);
  if (!fid || !l) return null;
  await setDoc(doc(db, 'families', fid, 'settings', 'app'), { lang: l }, { merge: true });
  return l;
}
// Подхватить язык семьи, если на этом устройстве выбора ещё не делали.
export function applyFamilyLang(settings) { return adoptFamilyLang(settings?.lang); }

// ── Темы семьи (§43) ────────────────────────────────────────────────────────
// Темы придумывает родитель (themes.html) и лежат они рядом с остальными
// настройками. Экран, которому нужны образы, зовёт applyFamilyThemes(settings)
// сразу после getSettings — дальше family-core отвечает на theme(id) темами
// ЭТОЙ семьи, а не пресетами.
export function applyFamilyThemes(settings) { return setFamilyThemes(settings?.themes); }
export async function loadFamilyThemes(fid) {
  const settings = await getSettings(fid).catch(() => null);
  applyFamilyThemes(settings);
  return settings;
}
// Пишем ВЕСЬ список разом: тем максимум четыре, порядок в нём значим (это
// порядок кнопок на экране «Кто ты сегодня?»), а поэлементная запись в массив
// Firestore этого порядка не гарантирует.
export async function saveFamilyThemes(fid, themes) {
  const list = normalizeThemes(themes);
  await setDoc(doc(db, 'families', fid, 'settings', 'app'), { themes: list }, { merge: true });
  setFamilyThemes(list);
  return list;
}

// Обязательность проверки по фото — настройка семьи, переключается в разделе
// эталонов (reference.html), читается раундом (scan.html).
export async function setPhotoCheckRequired(fid, required) {
  await setDoc(doc(db, 'families', fid, 'settings', 'app'), { photoCheckRequired: !!required }, { merge: true });
  return !!required;
}

export async function saveSettings(fid, settings) {
  await setDoc(doc(db, 'families', fid, 'settings', 'app'), settings, { merge: true });
}
