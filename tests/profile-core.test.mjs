// Тесты профилей и PIN-замков (node --test; WebCrypto есть и в Node).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeProfileId, normalizeProfile, normalizeProfiles, isLocked,
  pickActiveProfile, findProfile, parentLock, parentAreaLocked,
} from '../js/profile-core.js';
import { isValidPin, hashPin, verifyPin, hasPinLock } from '../js/pin.js';

test('PIN — ровно четыре цифры', () => {
  assert.ok(isValidPin('0000') && isValidPin('4271'));
  assert.ok(!isValidPin('123') && !isValidPin('12345') && !isValidPin('12a4') && !isValidPin(''));
});

test('в базе лежит хэш, а не PIN', async () => {
  const lock = await hashPin('4271');
  assert.ok(lock.salt && lock.hash);
  assert.ok(!JSON.stringify(lock).includes('4271'), 'цифры не утекают в документ');
  assert.ok(hasPinLock(lock));
});

test('верный PIN открывает, неверный — нет', async () => {
  const lock = await hashPin('4271');
  assert.equal(await verifyPin('4271', lock), true);
  assert.equal(await verifyPin('4272', lock), false);
  assert.equal(await verifyPin('427', lock), false, 'короткий ввод не проходит');
});

test('одинаковые PIN у двух детей дают разные хэши — по базе не видно совпадения', async () => {
  const a = await hashPin('1111'), b = await hashPin('1111');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(await verifyPin('1111', a), true);
  assert.equal(await verifyPin('1111', b), true);
});

test('профиль без PIN пускает всех — осознанный выбор для малыша', async () => {
  assert.equal(await verifyPin('', null), true);
  assert.equal(await verifyPin('9999', {}), true);
  assert.equal(isLocked({ id: 'a' }), false);
  assert.equal(isLocked({ id: 'a', pin: { salt: 's', hash: 'h' } }), true);
  assert.equal(isLocked({ id: 'a', pin: { salt: 's' } }), false, 'половина замка — не замок');
});

test('профиль без id не существует', () => {
  assert.equal(normalizeProfile({ name: 'Майя' }), null);
  assert.equal(normalizeProfiles([{ id: 'a' }, {}, null]).length, 1);
  assert.equal(normalizeProfile({ id: 'a' }).avatar, '🧒');
});

test('профили идут в порядке создания — список не прыгает под рукой ребёнка', () => {
  const list = normalizeProfiles([
    { id: 'b', name: 'Боря', createdAt: '2026-02-01' },
    { id: 'a', name: 'Аня', createdAt: '2026-01-01' },
  ]);
  assert.deepEqual(list.map(p => p.id), ['a', 'b']);
});

test('активный профиль: сохранённый — если он ещё есть, иначе выбирают заново', () => {
  const list = [{ id: 'maya' }, { id: 'kolya' }];
  assert.equal(pickActiveProfile(list, 'kolya'), 'kolya');
  assert.equal(pickActiveProfile(list, 'удалённый'), null, 'не сваливаемся в чужой профиль');
  assert.equal(pickActiveProfile(list, null), null, 'без выбора — экран выбора, а не первый попавшийся');
  assert.equal(pickActiveProfile([], 'maya'), null);
  assert.equal(findProfile(list, 'maya').id, 'maya');
  assert.equal(findProfile(list, 'нет'), null);
});

test('id профиля безопасен для пути и не зависит от Firebase', () => {
  assert.equal(makeProfileId('Майя', () => 0), 'kid-0', 'кириллица → безопасный слаг');
  assert.equal(makeProfileId('Maya', () => 0), 'maya-0');
  assert.match(makeProfileId('', () => 0), /^kid-/);
});

test('родительская часть: пока PIN не задан — открыта, иначе под замком', async () => {
  assert.equal(parentAreaLocked({}), false, 'первый родитель не должен запереть сам себя');
  assert.equal(parentAreaLocked(null), false);
  const lock = await hashPin('9182');
  assert.equal(parentAreaLocked({ parentPin: lock }), true);
  assert.deepEqual(parentLock({ parentPin: lock }), { salt: lock.salt, hash: lock.hash });
  assert.equal(await verifyPin('9182', parentLock({ parentPin: lock })), true);
});
