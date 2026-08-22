// Единая инициализация Firebase для «Наведи и убери» (перенос Twin js/firebase.js).
// Отдельный Firebase-проект help-me-clean-7969f (Auth + Firestore + Storage).
// Конфиг публичный по дизайну — доступ гейтят Firestore/Storage rules.
// Замена конфига — Console → Project settings → General → Your apps → Web.
// См. SETUP.md.
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence, inMemoryPersistence,
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-storage.js";

export {
  collection, collectionGroup, getDocs, doc, setDoc, deleteDoc, getDoc,
  query, where, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

export {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";

export {
  ref as storageRef, uploadBytes, getDownloadURL, deleteObject,
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDnFf016bxLlOY4M1hefsKcouLuZzvLx8Y",
  authDomain: "help-me-clean-7969f.firebaseapp.com",
  projectId: "help-me-clean-7969f",
  storageBucket: "help-me-clean-7969f.firebasestorage.app",
  messagingSenderId: "1050095126739",
  appId: "1:1050095126739:web:c39b05ca0bb971157dec26",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
// Реальный projectId, в который ходит приложение (для диагностики).
export const projectId = app.options.projectId;

// Вход — один раз на устройство (§139): сессия не истекает, ребёнок больше не
// видит экран входа. browserLocalPersistence переживает перезапуск браузера/PWA.
export const persistenceReady = setPersistence(auth, browserLocalPersistence)
  .catch(e => console.warn('setPersistence:', e?.code || e));

// Вторичный Firebase-app для создания детского аккаунта родителем: держит свою
// (in-memory, не переживает перезагрузку) сессию, чтобы создание нового
// пользователя НЕ перелогинивало родителя в основном инстансе. Одноразовый —
// после работы вызвать destroy().
export async function createSecondaryAuth() {
  const secApp = initializeApp(firebaseConfig, 'secondary-' + Date.now());
  const secAuth = getAuth(secApp);
  await setPersistence(secAuth, inMemoryPersistence).catch(() => {});
  return { auth: secAuth, destroy: () => deleteApp(secApp).catch(() => {}) };
}

// Разрешается после восстановления сессии — страницы, пишущие в Firestore/Storage,
// ждут, чтобы запросы ушли с токеном (важно для rules по членству).
export const authReady = persistenceReady.then(() => new Promise(resolve => {
  const off = onAuthStateChanged(auth, user => { off(); resolve(user); });
}));
