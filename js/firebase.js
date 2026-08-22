// Единая инициализация Firebase для «Наведи и убери» (перенос Twin js/firebase.js).
// Отдельный Firebase-проект (Auth + Firestore + Storage). Конфиг публичный по
// дизайну — доступ гейтят Firestore/Storage rules.
//
// ⚠️ ЗАПОЛНИТЬ: вставь web-конфиг своего Firebase-проекта (Console → Project
// settings → General → Your apps → Web). См. SETUP.md.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence,
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
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.firebasestorage.app",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);

// Вход — один раз на устройство (§139): сессия не истекает, ребёнок больше не
// видит экран входа. browserLocalPersistence переживает перезапуск браузера/PWA.
export const persistenceReady = setPersistence(auth, browserLocalPersistence)
  .catch(e => console.warn('setPersistence:', e?.code || e));

// Разрешается после восстановления сессии — страницы, пишущие в Firestore/Storage,
// ждут, чтобы запросы ушли с токеном (важно для rules по членству).
export const authReady = persistenceReady.then(() => new Promise(resolve => {
  const off = onAuthStateChanged(auth, user => { off(); resolve(user); });
}));
