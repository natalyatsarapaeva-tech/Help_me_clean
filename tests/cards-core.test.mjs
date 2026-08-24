// Тесты ядра коллекции (node --test, без Firebase/DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_ANY, cardThemes, isValidCardTheme, normalizeCardTheme,
  normalizeCard, normalizeCatalog, cardsPool, availableCards, pickCard,
  collectionView, catalogSummary, makeCardId,
} from '../js/cards-core.js';
import { emptyRewards, addCard, cardsForTheme, themeIds } from '../js/family-core.js';

const CATALOG = [
  { id: 'kevin', name: 'Шипастик', theme: 'sunny', url: 'https://x/1.jpg' },
  { id: 'bob', name: 'Боб', theme: 'sunny', url: 'https://x/2.jpg' },
  { id: 'yoda', name: 'Йода', theme: 'starry', url: 'https://x/3.jpg' },
  { id: 'dacha', name: 'Дача 2019', theme: 'any', url: 'https://x/4.jpg' },
];

test('темы карточек: темы семьи плюс «любая»', () => {
  assert.deepEqual(cardThemes(), [CARD_ANY, ...themeIds()]);
  assert.ok(isValidCardTheme('sunny') && isValidCardTheme('any'));
  assert.ok(!isValidCardTheme('sith'));
  assert.equal(normalizeCardTheme('sith'), 'any', 'непонятная тема — общая, карточка не теряется');
  assert.equal(normalizeCardTheme('sunny'), 'sunny', 'карточки франшизных образов не осиротели');
});

test('карточка без картинки или без id не попадает в каталог', () => {
  assert.equal(normalizeCard({ id: 'x' }), null, 'нет url');
  assert.equal(normalizeCard({ url: 'https://x/1.jpg' }), null, 'нет id');
  assert.equal(normalizeCard(null), null);
  assert.equal(normalizeCatalog([{ id: 'a', url: 'u' }, { id: 'b' }, null]).length, 1);
  assert.equal(normalizeCard({ id: 'a', url: 'u' }).theme, 'any');
});

test('витрина образа = свои карточки + общие, в порядке каталога', () => {
  assert.deepEqual(cardsPool(CATALOG, 'sunny').map(c => c.id), ['kevin', 'bob', 'dacha']);
  assert.deepEqual(cardsPool(CATALOG, 'starry').map(c => c.id), ['yoda', 'dacha']);
  assert.deepEqual(cardsPool(CATALOG, 'нет такой темы').map(c => c.id), ['kevin', 'bob', 'dacha'],
    'непонятный образ — фолбэк, а не пустая витрина');
});

test('выдаётся только то, чего у ребёнка ещё нет', () => {
  assert.deepEqual(availableCards(CATALOG, 'sunny', ['kevin']).map(c => c.id), ['bob', 'dacha']);
  assert.equal(pickCard(CATALOG, 'sunny', ['kevin'], () => 0).id, 'bob');
  assert.equal(pickCard(CATALOG, 'sunny', ['kevin'], () => 0.99).id, 'dacha', 'верхняя граница rand не выходит за массив');
  assert.equal(pickCard(CATALOG, 'starry', ['yoda', 'dacha'], () => 0), null, 'всё собрано — ничего не выдаём');
  assert.equal(pickCard([], 'sunny', [], () => 0), null);
});

test('чужой образ не отдаёт свои карточки', () => {
  assert.ok(!availableCards(CATALOG, 'starry', []).some(c => c.id === 'kevin'));
  assert.ok(availableCards(CATALOG, 'starry', []).some(c => c.id === 'dacha'), 'общие — в обоих образах');
});

test('витрина показывает и закрытые слоты — коллекция должна выглядеть продолжающейся', () => {
  const v = collectionView(CATALOG, 'sunny', ['bob']);
  assert.equal(v.total, 3);
  assert.equal(v.got, 1);
  assert.equal(v.complete, false);
  assert.deepEqual(v.cards.map(c => c.owned), [false, true, false]);
  assert.deepEqual(collectionView(CATALOG, 'starry', ['yoda', 'dacha']).complete, true);
  assert.deepEqual(collectionView([], 'sunny', []), { cards: [], got: 0, total: 0, complete: false, orphans: [] });
});

test('удалённая родителем карточка исчезает с витрины, но не отнимается', () => {
  const v = collectionView(CATALOG, 'sunny', ['bob', 'старая-карточка']);
  assert.equal(v.got, 1, 'в счётчике витрины только существующие');
  assert.deepEqual(v.orphans, ['старая-карточка'], 'но факт добычи виден и не стирается');
});

test('сводка каталога для родителя', () => {
  const s = catalogSummary(CATALOG);
  assert.equal(s.total, 4);
  assert.equal(s.byTheme.sunny, 2);
  assert.equal(s.byTheme.starry, 1);
  assert.equal(s.byTheme.any, 1);
});

test('id карточки: читаемый, стабильный, без кириллицы в пути', () => {
  assert.equal(makeCardId('Шипастик', () => 0), 'card-0', 'кириллица не в [a-z0-9] → безопасный слаг');
  assert.equal(makeCardId('Bob the Builder', () => 0), 'bob-the-builder-0');
  assert.match(makeCardId('', () => 0), /^card-/);
  assert.ok(makeCardId('a'.repeat(60), () => 0).length < 40, 'длинное имя обрезается');
});

test('выдача кладётся в коллекцию ИМЕННО этого образа', () => {
  const card = pickCard(CATALOG, 'sunny', [], () => 0);
  const rewards = addCard(emptyRewards(), 'sunny', card.id);
  assert.deepEqual(cardsForTheme(rewards, 'sunny'), ['kevin']);
  assert.deepEqual(cardsForTheme(rewards, 'starry'), [], 'у второй темы витрина своя');
  assert.deepEqual(addCard(rewards, 'sunny', 'kevin').cardsByTheme.sunny, ['kevin'], 'дубль не добавляется');
});
