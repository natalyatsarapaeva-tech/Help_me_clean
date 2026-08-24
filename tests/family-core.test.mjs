// Тесты чистого ядра (node --test, без Firebase/DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, PARENT, CHILD, isValidRole, canManageFamily, canAccessProfile,
  makeJoinCode, normalizeJoinCode, isValidJoinCode,
  makeFamilyId, makeSessionId, pickActiveFamily,
  ROOM_TYPES, normalizeRoomType, ACTION_IDS, ACTION_CATEGORIES, actionCategory, isValidActionCategory,
  normalizeActionCategory, cleanPlace, tidyStandard, tidyStandardText,
  themeIds, theme, isValidTheme, normalizeTheme, fallbackThemeId, rankForCleanups, rankNames,
  setFamilyThemes, familyThemes, photoCheckRequired, canFinishUnverified,
  SPARKLES, sparklesFor, nextSurpriseIn, shouldSurprise,
  emptyRewards, normalizeRewards, cardsForTheme, addCard, addSparkles,
  cornersToXywh, parseJsonObject, parseJsonArray, stripJsonFences,
  sanitizeScan, sanitizeVerify, sanitizeHome, ZONE_IDS, zoneKind, normalizeZoneKind, zoneNeedsCloseup, clampPoint,
  roomTypeLabel, roomsInOrder, defaultRouteOrder, moveInArray, reconcileRouteOrder,
  VERIFY_LIMITS, missedPhrase,
  referenceCoverage,
} from '../js/family-core.js';
import { setLang } from '../js/i18n.js';

// Ядро отдаёт человеческие подписи на текущем языке (js/i18n.js). Фикстуры и
// ожидания здесь русские, поэтому язык фиксируем явно — иначе тест проверял бы
// не логику, а то, какой язык оказался умолчанием. Полноту словарей и работу
// переключения проверяет tests/i18n.test.mjs.
setLang('ru');

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

test('темы: пока настройки не загружены — пресеты семьи', () => {
  setFamilyThemes(null);
  assert.deepEqual(themeIds(), ['sunny', 'starry']);
  assert.equal(theme('unknown').id, fallbackThemeId()); // фолбэк только для отрисовки
  assert.ok(isValidTheme('starry') && !isValidTheme('sith'));
  // У профиля НЕТ темы по умолчанию — «не выбрано» это null, а не первая тема.
  assert.equal(normalizeTheme(undefined), null);
  assert.equal(normalizeTheme('starry'), 'starry');
  // Франшизные id старых документов понимаются и после переезда на свои темы:
  // добытое ребёнком не должно пропасть из-за переименования.
  assert.equal(normalizeTheme('minion'), 'sunny');
  assert.equal(theme('jedi').id, 'starry');
});

test('темы семьи вытесняют пресеты, ранги берутся у темы', () => {
  setFamilyThemes([{ id: 'dino', name: 'Динозавры', emoji: '🦕',
    colors: { primary: 'grass', secondary: 'earth', accent: 'sun' },
    ranks: ['Яйцо', 'Ящерка', '', 'Тираннозавр'] }]);
  assert.deepEqual(themeIds(), ['dino']);
  assert.equal(theme('dino').label, 'Динозавры');
  assert.equal(theme('dino').currencyEmoji, '🦕');
  assert.equal(rankForCleanups(0, 'dino'), 'Яйцо');
  assert.equal(rankForCleanups(30, 'dino'), rankNames('dino')[2], 'пропуск в середине — название по умолчанию');
  assert.equal(rankForCleanups(100, 'dino'), 'Тираннозавр');
  assert.ok(rankNames('dino')[2].length > 2, 'пустой ранг подписан словарём, а не пустотой');
  // Тема, которой у семьи нет, рисуется первой — экран не остаётся без образа.
  assert.equal(theme('starry').id, 'dino');
  assert.equal(familyThemes()[0].name, 'Динозавры');
  setFamilyThemes(null);
});

test('проверка по фото: обязательна, пока родитель не сказал иначе', () => {
  assert.equal(photoCheckRequired(null), true);
  assert.equal(photoCheckRequired({}), true);
  assert.equal(photoCheckRequired({ photoCheckRequired: false }), false);
  assert.equal(canFinishUnverified({ photoCheckRequired: false }), true);
  assert.equal(canFinishUnverified({}), false, 'выход из проверки — только с разрешения семьи');
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

test('sanitizeVerify: планку держит код, а не настроение модели', () => {
  assert.equal(sanitizeVerify({ after_count: 0, left: [] }).status, 'done');
  assert.equal(sanitizeVerify({ person_detected: true }).status, 'person');
  assert.equal(sanitizeVerify({ retake: true }).status, 'retake');

  // Мусор не прощается вообще — даже одна бумажка.
  const trash = sanitizeVerify({ after_count: 1, left: [
    { label: 'бумажка', count: 1, category: 'trash', todo: 'выбросить бумажку' },
  ] });
  assert.equal(trash.done, false);
  assert.equal(trash.trashLeft, 1);

  // Три посторонние вещи — допуск, четыре — уже неубранная поверхность.
  const three = sanitizeVerify({ after_count: 3, left: [
    { label: 'книга', count: 2, category: 'belongs_elsewhere' },
    { label: 'кружка', count: 1, category: 'dishes' },
  ] });
  assert.equal(three.done, true, 'придираться к забытой кружке нельзя');
  assert.equal(three.othersLeft, 3);
  const four = sanitizeVerify({ after_count: 4, left: [{ label: 'книги', count: 4, category: 'paper' }] });
  assert.equal(four.done, false);
  assert.deepEqual(VERIFY_LIMITS, { trash: 0, others: 3 });
});

test('нечитаемый ответ — это не «убрано»', () => {
  // Так и выглядел баг: сняли захламлённую тумбочку дважды, модель вернула
  // пустой список и похвалу — и уборка засчитывалась.
  const silent = sanitizeVerify({ score: 'great', praise: 'Чисто!' });
  assert.equal(silent.done, false);
  assert.equal(silent.status, 'unclear', 'судить не по чему — просим переснять, а не награждаем');
  assert.equal(silent.unverified, true);
  // И слову «done» без единого числа больше не верим.
  assert.equal(sanitizeVerify({ done: true, praise: 'Молодец' }).done, false);
  // Явный ноль — совсем другое дело: модель посчитала и ничего не нашла.
  const clean = sanitizeVerify({ after_count: 0, before_count: 9, left: [] });
  assert.equal(clean.done, true);
  assert.equal(clean.improved, true);
});

test('счёт строже списка: три названные группы против девяти предметов', () => {
  const v = sanitizeVerify({
    before_count: 10, after_count: 10,
    left: [{ label: 'бумажки', count: 3, category: 'trash', todo: 'выбросить три бумажки' }],
  });
  assert.equal(v.trashLeft, 3);
  assert.equal(v.othersLeft, 7, 'из десяти лишних три — мусор, остальные семь тоже считаются');
  assert.equal(v.done, false);
  assert.equal(v.improved, false, 'фото «после» не отличается от «до»');
});

test('эталон родителей строже нашей тройки', () => {
  const strict = sanitizeVerify({ after_count: 3, reference_count: 1, left: [
    { label: 'книга', count: 3, category: 'paper' },
  ] });
  assert.equal(strict.overReference, true);
  assert.equal(strict.done, false, 'у семьи свой порядок, и он важнее общей планки');
  const ok = sanitizeVerify({ after_count: 1, reference_count: 1, left: [{ label: 'лампа', count: 1, category: 'paper' }] });
  assert.equal(ok.done, true);
});

test('рамки вокруг оставшегося: без них «убери лишнее» ничего не значит', () => {
  const v = sanitizeVerify({ after_count: 2, boxes: [
    { label: 'бумажка', box: [0.1, 0.2, 0.3, 0.4] },
    { label: 'кривая', box: [0.1, 0.2] },
  ] });
  assert.equal(v.boxes.length, 1, 'кривая рамка отброшена');
  const [x, y, w, h] = v.boxes[0].box;
  assert.deepEqual([x, y], [0.1, 0.2]);
  assert.ok(Math.abs(w - 0.2) < 1e-9 && Math.abs(h - 0.2) < 1e-9, 'углы приведены к x/y/w/h');
  // Счёт можно взять из рамок, если модель забыла итог.
  assert.equal(sanitizeVerify({ boxes: [{ label: 'а', box: [0, 0, 0.1, 0.1] }] }).afterCount, 1);
});

test('фраза «осталось только…» — конкретная, но не придирка', () => {
  const v = sanitizeVerify({ after_count: 4, left: [
    { label: 'бумажки', count: 3, category: 'trash', todo: 'выбросить три бумажки' },
    { label: 'кружка', count: 1, category: 'dishes', todo: 'отнести посуду на место' },
  ], praise: 'Да ты почти у цели!' });
  assert.equal(missedPhrase(v.left), 'выбросить три бумажки и отнести посуду на место');
  assert.equal(v.done, false, 'мусор остался');
  assert.deepEqual(v.missed, ['выбросить три бумажки', 'отнести посуду на место']);
  // Модель не дала готовую фразу — обходимся названием, а не молчим.
  assert.equal(missedPhrase([{ label: 'носки', count: 2 }]), 'убрать: носки');
  assert.equal(missedPhrase([]), '');
  assert.equal(missedPhrase([{ todo: 'а' }, { todo: 'б' }, { todo: 'в' }, { todo: 'г' }]), 'а, б и в',
    'больше трёх дел за раз ребёнку не удержать');
});

test('награды: валюта общая на ребёнка, коллекции — по темам', () => {
  const fresh = emptyRewards();
  assert.equal(fresh.currency, 0);
  assert.deepEqual(Object.keys(fresh.cardsByTheme), themeIds());

  // Валюта не зависит от темы: копится у ребёнка, смена темы её не трогает.
  let r = addSparkles(fresh, 'step');
  r = addSparkles(r, 'room');
  assert.equal(r.currency, SPARKLES.step + SPARKLES.room);
  assert.equal(r.cleanupsTotal, 0);
  r = addSparkles(r, 'day');           // пройден маршрут дня
  assert.equal(r.cleanupsTotal, 1);

  // Карточки живут в коллекции своей темы и не смешиваются.
  r = addCard(r, 'sunny', 'sticker-01');
  r = addCard(r, 'starry', 'droid-01');
  r = addCard(r, 'sunny', 'sticker-01'); // дубль игнорируется
  assert.deepEqual(cardsForTheme(r, 'sunny'), ['sticker-01']);
  assert.deepEqual(cardsForTheme(r, 'starry'), ['droid-01']);

  // Вход не мутируется.
  assert.equal(fresh.currency, 0);
  assert.deepEqual(fresh.cardsByTheme.sunny, []);
});

test('нормализация наград: миграция старого плоского cards[]', () => {
  const migrated = normalizeRewards({ currency: 7, cards: ['old-1', 'old-2'], cleanupsTotal: 3 });
  assert.equal(migrated.currency, 7);
  assert.equal(migrated.cleanupsTotal, 3);
  assert.deepEqual(migrated.cardsByTheme[fallbackThemeId()], ['old-1', 'old-2']);
  assert.deepEqual(migrated.cardsByTheme.starry, []);
  // Мусор на входе не роняет.
  assert.deepEqual(normalizeRewards(null), emptyRewards());
});

test('нормализация наград: добытое в старых и удалённых темах не пропадает', () => {
  // Коллекции франшизных образов переезжают в свои темы...
  const moved = normalizeRewards({ cardsByTheme: { minion: ['a'], jedi: ['b'] } });
  assert.deepEqual(moved.cardsByTheme.sunny, ['a']);
  assert.deepEqual(moved.cardsByTheme.starry, ['b']);
  // ...а коллекция темы, которую родитель удалил, остаётся в документе: витрина
  // её не покажет, но отнимать добытое нельзя (§336).
  const orphan = normalizeRewards({ cardsByTheme: { dino: ['rex'] } });
  assert.deepEqual(orphan.cardsByTheme.dino, ['rex']);
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
  const all = tidyStandard().join(' ').toLowerCase();
  assert.match(all, /пуст/, 'пустая поверхность — норма');
  assert.match(all, /лампа/, 'исключение для письменного стола');
  assert.match(all, /стул/, 'на стульях вещей нет');
  assert.match(all, /кровать заправлена|заправлена/, 'кровать заправлена');
  assert.match(all, /пол свободен|на полу не место/, 'пол свободен');
  assert.match(all, /урн/, 'полная урна — отдельная задача');
  assert.ok(tidyStandardText().startsWith('- '), 'готова к подстановке в промпт');
  assert.equal(tidyStandardText().split('\n').length, tidyStandard().length);
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


// ── Очаги комнаты (режим «фото комнаты») ────────────────────────────────────
test('sanitizeScan overview: очаги вместо россыпи точек', () => {
  const out = sanitizeScan({
    mode: 'overview', place: '«Детская»', estimated_minutes: 12,
    zones: [
      { id: 1, kind: 'desk', label: 'стол', point: [0.6, 0.4], category: 'paper', action: 'разбери стол', items_estimate: 9 },
      { id: 2, kind: 'выдумка', point: [0.2, 0.5], category: 'textile', items_estimate: 3 },
      { id: 3, kind: 'floor', point: [0.4, 0.9], category: 'нет-такой-категории' },
    ],
  });
  assert.equal(out.zones.length, 2, 'очаг без валидной категории действия отбрасываем');
  assert.equal(out.zones[0].needsCloseup, true, 'девять мелочей на столе — надо подойти');
  assert.equal(out.zones[1].kind, 'other', 'выдуманный вид очага сводится к «ещё»');
  assert.equal(out.zones[1].label, 'ещё', 'без подписи берём название вида очага');
  assert.equal(out.zones[1].needsCloseup, false);
  assert.equal(out.place, 'детская');
  assert.equal(out.estimated_minutes, 12);
});

test('кривые координаты очаг не выбрасывают — метка встаёт в центр', () => {
  assert.deepEqual(clampPoint([2, -1]), [1, 0]);
  assert.deepEqual(clampPoint(null), [0.5, 0.5]);
  assert.deepEqual(clampPoint(['x', 0.3]), [0.5, 0.3]);
  const out = sanitizeScan({ mode: 'overview', zones: [{ kind: 'bed', category: 'make_bed' }] });
  assert.equal(out.zones.length, 1, 'реальную работу терять хуже, чем нарисовать кружок не там');
  assert.deepEqual(out.zones[0].point, [0.5, 0.5]);
  assert.equal(out.zones[0].label, 'кровать', 'без подписи берём название вида очага');
});

test('крупный план: слово модели весомее умолчания по виду очага', () => {
  assert.equal(zoneNeedsCloseup('desk', 9, undefined), true);
  assert.equal(zoneNeedsCloseup('desk', 9, false), false, 'модель видела кадр — ей виднее');
  assert.equal(zoneNeedsCloseup('desk', 1, undefined), false, 'одна вещь на столе — подходить незачем');
  assert.equal(zoneNeedsCloseup('chair', 9, undefined), false, 'куча одежды на стуле и так понятна');
  assert.equal(zoneNeedsCloseup('bin', 1, true), true);
});

test('словарь очагов: у каждого есть эмодзи, имя и строка плана', () => {
  assert.ok(ZONE_IDS.includes('wipe') && ZONE_IDS.includes('other'));
  for (const id of ZONE_IDS) {
    const z = zoneKind(id);
    assert.ok(z.emoji && z.name && z.plan && z.color, id);
  }
  assert.equal(normalizeZoneKind('нет такого'), 'other');
  assert.equal(zoneKind('wipe').instruction, 'Протри поверхность',
    'у протирания нет категории действия — текст берётся из словаря очагов');
});
