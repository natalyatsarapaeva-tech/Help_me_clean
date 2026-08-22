// PIN как замок интерфейса (WebCrypto, работает и в Node — поэтому тестируется).
//
// Что изменилось по сравнению с прежней схемой: раньше PIN РАСШИФРОВЫВАЛ пароль
// служебного детского аккаунта, то есть был ключом к настоящему входу. Теперь
// планшет один раз логинится родителем, а PIN — это замок на профиле: он решает,
// кого пускают в чей профиль и кого пускают в родительскую часть.
//
// Хранится не сам PIN, а PBKDF2-хэш с индивидуальной солью: документ профиля
// читают все члены семьи, и брат не должен подглядеть цифры сестры, просто
// открыв базу. От перебора четырёх цифр это не спасает (10 000 вариантов), и
// не должно: замок здесь — от любопытства своих, а не от злоумышленника.
const ITERATIONS = 150000;
const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

const b64 = {
  to: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  from: (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};

export function isValidPin(pin) { return /^\d{4}$/.test(String(pin ?? '')); }

async function derive(pin, salt) {
  const base = await subtle().importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, 256);
  return b64.to(bits);
}

// Завести замок: { salt, hash }. Соль своя у каждого профиля — одинаковый PIN
// у двоих детей даёт разные хэши, и по базе не видно, что они совпали.
export async function hashPin(pin, salt = globalThis.crypto.getRandomValues(new Uint8Array(16))) {
  if (!isValidPin(pin)) throw new Error('bad-pin');
  const saltBytes = typeof salt === 'string' ? b64.from(salt) : salt;
  return { salt: b64.to(saltBytes), hash: await derive(pin, saltBytes) };
}

// Проверка. Пустой замок (PIN не задан) — открыт: профиль без PIN пускает всех,
// это осознанный выбор родителя для малыша, который цифры ещё не помнит.
export async function verifyPin(pin, stored) {
  if (!stored?.salt || !stored?.hash) return true;
  if (!isValidPin(pin)) return false;
  const { hash } = await hashPin(pin, stored.salt);
  return hash === stored.hash;
}

export function hasPinLock(stored) { return !!(stored?.salt && stored?.hash); }
