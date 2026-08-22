// Детский вход по аватару + PIN (§137). Ребёнок не знает email/пароль своего
// служебного аккаунта — знает только 4-значный PIN, который на ЭТОМ планшете
// расшифровывает сохранённый пароль.
//
// Схема: пароль шифруется AES-GCM ключом, выведенным из PIN через PBKDF2
// (WebCrypto). В localStorage лежит только {email, salt, iv, ciphertext} —
// без PIN его не расшифровать. PIN нигде не хранится.
//
// Провиженит устройство родитель (§141): вводит email/пароль детского аккаунта
// (или создаёт его) и задаёт PIN, дальше планшет логинится сам по PIN.

const CRED_KEY = 'tidy.childCred';   // { email, salt, iv, ct } — секрет под PIN
const LABEL_KEY = 'tidy.childLabel'; // { name, avatar } — несекретно, для экрана PIN
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = {
  to: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  from: (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};

async function keyFromPin(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

// Сохранить учётку ребёнка на устройстве под PIN. Вызывает родитель.
// label = { name, avatar } — несекретная подпись для экрана входа ребёнка.
export async function provisionChildDevice(pin, email, password, label = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFromPin(pin, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(password)));
  localStorage.setItem(CRED_KEY, JSON.stringify({
    email: String(email),
    salt: b64.to(salt), iv: b64.to(iv), ct: b64.to(ct),
  }));
  localStorage.setItem(LABEL_KEY, JSON.stringify({
    name: String(label.name || ''), avatar: String(label.avatar || ''),
  }));
}

// Есть ли на устройстве сохранённая детская учётка (показывать экран PIN, а не email).
export function hasChildDevice() { return !!localStorage.getItem(CRED_KEY); }

// Несекретная подпись (имя/аватар) для экрана PIN. null, если планшет не провижен.
export function childDeviceLabel() {
  try { return JSON.parse(localStorage.getItem(LABEL_KEY)) || null; } catch { return null; }
}

// Расшифровать email/пароль по PIN. Бросает, если PIN неверный (GCM не сойдётся).
export async function unlockChildCredentials(pin) {
  const raw = localStorage.getItem(CRED_KEY);
  if (!raw) throw new Error('no-child-device');
  const { email, salt, iv, ct } = JSON.parse(raw);
  const key = await keyFromPin(pin, b64.from(salt));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.from(iv) }, key, b64.from(ct));
  } catch (_) {
    throw new Error('wrong-pin');
  }
  return { email, password: dec.decode(plain) };
}

// Сбросить устройство (родитель разлогинивает планшет).
export function clearChildDevice() { localStorage.removeItem(CRED_KEY); localStorage.removeItem(LABEL_KEY); }
