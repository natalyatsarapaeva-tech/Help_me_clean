// Тесты чистого ядра (node --test, без Firebase/DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, PARENT, CHILD, isValidRole, canManageFamily, canAccessProfile,
  makeJoinCode, normalizeJoinCode, isValidJoinCode,
  makeFamilyId, makeSessionId, pickActiveFamily,
  ROOM_TYPES, normalizeRoomType, ACTION_IDS, ACTION_CATEGORIES, actionCategory, isValidActionCategory,
  normalizeActionCategory, cleanPlace, TIDY_STANDARD, TIDY_STANDARD_TEXT,
  THEME_IDS, theme, isValidTheme, normalizeTheme, FALLBACK_THEME, rankForCleanups, JEDI_RANKS,
  SPARKLES, sparklesFor, nextSurpriseIn, shouldSurprise,
  emptyRewards, normalizeRewards, cardsForTheme, addCard, addSparkles,
  cornersToXywh, parseJsonObject, parseJsonArray, stripJsonFences,
  sanitizeScan, sanitizeVerify, sanitizeHome,
  roomTypeLabel, roomsInOrder, defaultRouteOrder, moveInArray, reconcileRouteOrder,
  referenceCoverage,
} from '../js/family-core.js';

test('роли', () => {
  assert.deepEqual(ROLES, ['parent', 'child']);
  assert.ok(isValidRole(PARENT) && isValidRole(CHILD));
  assert.ok(!isValidRole('viewer'));
  assert.ok(canManageFamily(PARENT) && !canManageFamily(CHILD));
});

test('ребёнок заперт в свой профиль, родитель — везде', () => {
  assert.ok(canAccessProfile(PARENT, 'u1', 'u2'));      // родитель — чужой профиль
  assert.ok(canAccessProfile(CHILD, 'u1', 'u1'));       // ребёнок — свой
  assert.ok(!canAccessProfile(CHILD, 'u1', 'u2'));      // ребёнок — чужой: нет
});

test('коды присоединения: без похожих символов, 6 знаков', () => {
  const seq = [0.99, 0.0, 0.5, 0.3, 0.7, 0.1];
  let i = 0;
  const code = makeJoinCode(() => seq[i++ % seq.length]);
  assert.equal(code.length, 6);
  assert.ok(!/[ILO01]/.test(code));
  assert.equal(normalizeJoinCode(' k7q-mр2 '.replace('р', 'r')), 'K7QMR2');
  assert.ok(isValidJoinCode('ABCJ23'));
  assert.ok(!isValidJoinCode('AB2'));
});

test('id детерминированны при заданном rand', () => {
  assert.equal(makeFamilyId('Наш дом', () => 0), 'family-0'); // кириллица не в [a-z0-9] → слаг 'family'
  assert.equal(makeFamilyId('Smith Home', () => 0), 'smith-home-0');
  assert.match(makeSessionId(() => 1000, () => 0), /^sess-1000-0$/);
});

test('активная семья: сохранённая → первая → null', () => {
  const fams = [{ id: 'a' }, { id: 'b' }];
  assert.equal(pickActiveFamily(fams, 'b'), 'b');
  assert.equal(pickActiveFamily(fams, 'zzz'), 'a');
  assert.equal(pickActiveFamily([], 'a'), null);
});

test('типы комнат и цветовой словарь — закрытые списки', () => {
  assert.equal(ROOM_TYPES.length, 7);
  assert.equal(normalizeRoomType('kitchen'), 'kitchen');
  assert.equal(normalizeRoomType('nonsense'), 'other');
  assert.equal(ACTION_IDS.length, 10);
  assert.ok(isValidActionCategory('paper') && !isValidActionCategory('blue'));
  assert.equal(actionCategory('trash').target, 'Ведро');
});

test('темы и ранги', () => {
  assert.deepEqual(THEME_IDS, ['minion', 'jedi']);
  assert.equal(theme('minion').currencyName, 'бананы');
  assert.equal(theme('unknown').id, FALLBACK_THEME); // фолбэк только для отрисовки
  assert.ok(isValidTheme('jedi') && !isValidTheme('sith'));
  // У профиля НЕТ темы по умолчанию — «не выбрано» это null, а не 'minion'.
  assert.equal(normalizeTheme(undefined), null);
  assert.equal(normalizeTheme('jedi'), 'jedi');
  assert.equal(rankForCleanups(0), JEDI_RANKS[0]);
  assert.equal(rankForCleanups(100), JEDI_RANKS[3]);
});

test('награды и сюрпризы', () => {
  assert.equal(sparklesFor('room'), SPARKLES.room);
  assert.equal(nextSurpriseIn(() => 0), 2);   // min
  assert.equal(nextSurpriseIn(() => 0.999), 7); // max
  assert.ok(shouldSurprise(5, 4) && !shouldSurprise(3, 4));
});

test('cornersToXywh: углы → [x,y,w,h], порядок углов не важен', () => {
  const got = cornersToXywh([0.49, 0.95, 0.02, 0.08]).map(n => Math.round(n * 100) / 100);
  assert.deepEqual(got, [0.02, 0.08, 0.47, 0.87]);
  assert.equal(cornersToXywh([1, 2, 3]), null);
});

test('парсинг JSON из ответа модели (фенсы, мусор вокруг)', () => {
  assert.deepEqual(parseJsonArray('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(parseJsonObject('текст {"x":2} хвост'), { x: 2 });
  assert.equal(stripJsonFences('```json\n{}\n```'), '{}');
  assert.deepEqual(parseJsonArray('не json'), []);
});

test('sanitizeScan closeup: отбрасывает неизвестные категории, считает группы', () => {
  const out = sanitizeScan({
    mode: 'closeup',
    items: [
      { id: 1, label: 'тетрадь', category: 'paper', box: [0.1, 0.2, 0.3, 0.4] },
      { id: 2, label: '?', category: 'unknown', box: [0, 0, 1, 1] },
      { id: 3, label: 'ручка', category: 'stationery', bbox: [0.5, 0.5, 0.1, 0.1] },
    ],
  });
  assert.equal(out.items.length, 2); // unknown выброшен
  assert.deepEqual(out.items[0].box.map(n => Math.round(n * 100) / 100), [0.1, 0.2, 0.2, 0.2]); // углы → xywh
  const paper = out.groups.find(g => g.category === 'paper');
  assert.equal(paper.count, 1);
  assert.equal(paper.instruction, actionCategory('paper').instruction);
});

test('sanitizeVerify: мягкая оценка, одна пропущенная вещь, person/retake', () => {
  assert.equal(sanitizeVerify({ done: true, score: 'great', praise: 'Чисто!' }).status, 'done');
  const inc = sanitizeVerify({ done: false, missed: ['носок', 'книга', 'кружка'] });
  assert.equal(inc.missed.length, 1); // §296 — одна вещь, не список
  assert.equal(sanitizeVerify({ person_detected: true }).status, 'person');
  assert.equal(sanitizeVerify({ retake: true }).status, 'retake');
});

test('награды: валюта общая на ребёнка, коллекции — по темам', () => {
  const fresh = emptyRewards();
  assert.equal(fresh.currency, 0);
  assert.deepEqual(Object.keys(fresh.cardsByTheme), THEME_IDS);

  // Валюта не зависит от темы: копится у ребёнка, смена темы её не трогает.
  let r = addSparkles(fresh, 'step');
  r = addSparkles(r, 'room');
  assert.equal(r.currency, SPARKLES.step + SPARKLES.room);
  assert.equal(r.cleanupsTotal, 0);
  r = addSparkles(r, 'day');           // пройден маршрут дня
  assert.equal(r.cleanupsTotal, 1);

  // Карточки живут в коллекции своей темы и не смешиваются.
  r = addCard(r, 'minion', 'banana-01');
  r = addCard(r, 'jedi', 'droid-01');
  r = addCard(r, 'minion', 'banana-01'); // дубль игнорируется
  assert.deepEqual(cardsForTheme(r, 'minion'), ['banana-01']);
  assert.deepEqual(cardsForTheme(r, 'jedi'), ['droid-01']);

  // Вход не мутируется.
  assert.equal(fresh.currency, 0);
  assert.deepEqual(fresh.cardsByTheme.minion, []);
});

test('нормализация наград: миграция старого плоского cards[]', () => {
  const migrated = normalizeRewards({ currency: 7, cards: ['old-1', 'old-2'], cleanupsTotal: 3 });
  assert.equal(migrated.currency, 7);
  assert.equal(migrated.cleanupsTotal, 3);
  assert.deepEqual(migrated.cardsByTheme[FALLBACK_THEME], ['old-1', 'old-2']);
  assert.deepEqual(migrated.cardsByTheme.jedi, []);
  // Мусор на входе не роняет.
  assert.deepEqual(normalizeRewards(null), emptyRewards());
});

test('карта дома: порядок обхода, домашняя комната первой, reorder', () => {
  const home = { floors: [
    { name: '2 этаж', rooms: [{ id: 'maya' }, { id: 'bath' }] },
    { name: '1 этаж', rooms: [{ id: 'kitchen' }] },
  ] };
  assert.equal(roomTypeLabel('kitchen'), 'Кухня');
  assert.equal(roomTypeLabel('zzz'), 'Другое');
  assert.deepEqual(roomsInOrder(home).map(r => r.id), ['maya', 'bath', 'kitchen']);
  assert.deepEqual(roomsInOrder(home)[0].floor, '2 этаж');
  // §215 — домашняя комната ребёнка идёт первой.
  assert.deepEqual(defaultRouteOrder(home, 'kitchen'), ['kitchen', 'maya', 'bath']);
  assert.deepEqual(defaultRouteOrder(home, null), ['maya', 'bath', 'kitchen']);
  // reorder не мутирует вход.
  const src = ['a', 'b', 'c'];
  assert.deepEqual(moveInArray(src, 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(src, ['a', 'b', 'c']);
  assert.deepEqual(moveInArray(src, 5, 0), ['a', 'b', 'c']); // out of range — без изменений
  // reconcile: убрать исчезнувшие, дописать новые.
  assert.deepEqual(reconcileRouteOrder(['bath', 'gone', 'maya'], home), ['bath', 'maya', 'kitchen']);
});

test('sanitizeHome: валидные типы комнат, отбрасывает пустое', () => {
  const out = sanitizeHome({
    floors: [{
      name: 'Первый этаж',
      rooms: [
        { id: 'kitchen', name: 'Кухня', type: 'kitchen', icon: '🍳' },
        { name: '', type: 'bedroom_child' },      // без имени — выброс
        { id: 'x', name: 'Странная', type: 'zzz' }, // неизвестный тип → other
      ],
    }, { name: 'Пусто', rooms: [] }],              // без комнат — выброс
  });
  assert.equal(out.floors.length, 1);
  assert.equal(out.floors[0].rooms.length, 2);
  assert.equal(out.floors[0].rooms[1].type, 'other');
});

test('покрытие эталонами: что снято, что нет', () => {
  const rooms = [{ id: 'kitchen', name: 'Кухня' }, { id: 'maya', name: 'Комната Майи' }];
  const cov = referenceCoverage(rooms, [{ id: 'kitchen', url: 'https://x/1.jpg' }]);
  assert.equal(cov.covered, 1);
  assert.equal(cov.total, 2);
  assert.equal(cov.complete, false);
  assert.equal(cov.rooms[0].reference.url, 'https://x/1.jpg');
  assert.equal(cov.rooms[1].reference, null);
  assert.equal(cov.rooms[0].name, 'Кухня', 'комната не теряет своих полей');

  const all = referenceCoverage(rooms, [{ surfaceId: 'kitchen' }, { surfaceId: 'maya' }]);
  assert.ok(all.complete, 'документы бывают и с surfaceId вместо id');

  const none = referenceCoverage([], [{ id: 'kitchen' }]);
  assert.deepEqual(none, { rooms: [], covered: 0, total: 0, complete: false });
  assert.equal(referenceCoverage(null, null).total, 0);
});

test('текстиль вместо одежды: полотенце и тряпка не должны быть «одеждой»', () => {
  const t = actionCategory('textile');
  assert.equal(t.id, 'textile');
  assert.match(t.instruction, /Текстиль/);
  assert.ok(ACTION_IDS.includes('textile'));
  assert.ok(!ACTION_IDS.includes('clothes'), 'старой категории в словаре больше нет');
});

test('старый id clothes продолжает читаться — прогресс и ответы модели не ломаются', () => {
  assert.equal(normalizeActionCategory('clothes'), 'textile');
  assert.equal(actionCategory('clothes').id, 'textile');
  assert.ok(isValidActionCategory('clothes'), 'сохранённые сессии не становятся мусором');
  assert.equal(normalizeActionCategory('выдумка'), 'выдумка');
  const scan = sanitizeScan({ mode: 'closeup', items: [
    { id: 1, label: 'полотенце', category: 'clothes', box: [0, 0, 0.2, 0.2] },
  ] });
  assert.equal(scan.items[0].category, 'textile', 'ответ модели на старом языке приводится к новому');
});

test('имя места приводится к сравнимому виду — иначе лимит обходится кавычками', () => {
  assert.equal(cleanPlace('«Раковина».  '), 'раковина');
  assert.equal(cleanPlace('Стол   у окна'), 'стол у окна');
  assert.equal(cleanPlace(null), '');
  assert.equal(cleanPlace('a'.repeat(80)).length, 40, 'длинное описание подрезается');
  assert.equal(sanitizeScan({ mode: 'closeup', place: 'Раковина', items: [] }).place, 'раковина');
});

test('норма порядка одна на всё приложение и покрывает поднятые требования', () => {
  const all = TIDY_STANDARD.join(' ').toLowerCase();
  assert.match(all, /пуст/, 'пустая поверхность — норма');
  assert.match(all, /лампа/, 'исключение для письменного стола');
  assert.match(all, /стул/, 'на стульях вещей нет');
  assert.match(all, /кровать заправлена|заправлена/, 'кровать заправлена');
  assert.match(all, /пол свободен|на полу не место/, 'пол свободен');
  assert.match(all, /урн/, 'полная урна — отдельная задача');
  assert.ok(TIDY_STANDARD_TEXT.startsWith('- '), 'готова к подстановке в промпт');
  assert.equal(TIDY_STANDARD_TEXT.split('\n').length, TIDY_STANDARD.length);
});

test('новые категории: пол, кровать, полная урна', () => {
  for (const id of ['floor', 'make_bed', 'bin_full']) {
    assert.ok(ACTION_IDS.includes(id), id);
    assert.ok(actionCategory(id).instruction.length > 5);
    assert.match(actionCategory(id).color, /^#[0-9A-F]{6}$/i);
  }
  assert.match(actionCategory('floor').instruction, /пол/i);
  assert.match(actionCategory('bin_full').instruction, /урна/i);
  assert.match(actionCategory('make_bed').instruction, /кровать/i);
  const colors = ACTION_CATEGORIES.map(c => c.color);
  assert.equal(new Set(colors).size, colors.length, 'цвета не повторяются — иначе шаги не различить');
});

test('«чужая вещь» спрашивает ребёнка, а не отправляет в корзину', () => {
  const c = actionCategory('belongs_elsewhere');
  assert.match(c.instruction, /не живёт/);
  assert.match(c.instruction, /вспомни/i);
  assert.ok(!/корзин/i.test(c.instruction + c.target), 'корзины «чужое» больше нет');
});
