// Тесты ядра тем (node --test, без Firebase/DOM).
//
// Смысл файла: тема — это то, что родитель собирает руками, а ребёнок видит на
// каждом экране. Поэтому машинно проверяем ровно те свойства, поломка которых
// заметна только на живом планшете: лимит в четыре темы, читаемость палитры,
// «переименовал тему — коллекция осталась», «последнюю тему не удалить».
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE, PALETTE_IDS, COLOR_ROLES, MAX_THEMES, RANK_COUNT, THEME_EMOJI,
  defaultThemes, normalizeTheme, normalizeThemes, migrateLegacyThemeId,
  resolveTheme, themeRanks, themeCssVars, readableInk, luminance, mixHex,
  makeThemeId, validateTheme, canAddTheme, addTheme, updateTheme, removeTheme, draftTheme,
} from '../js/themes-core.js';
import { setLang, getLang } from '../js/i18n.js';

const restore = (fn) => { const was = getLang(); try { return fn(); } finally { setLang(was); } };
const dino = {
  id: 'dino', name: 'Динозавры', emoji: '🦕',
  colors: { primary: 'grass', secondary: 'earth', accent: 'sun' },
  ranks: ['Яйцо', 'Ящерка', 'Хищник', 'Тираннозавр'],
};

test('палитра: двенадцать цветов, все разные и все — валидные hex', () => {
  assert.equal(PALETTE.length, 12, 'меньше — не из чего выбрать, больше — уже не выбор, а колесо');
  assert.equal(new Set(PALETTE_IDS).size, PALETTE.length);
  assert.equal(new Set(PALETTE.map(c => c.hex)).size, PALETTE.length);
  for (const c of PALETTE) assert.match(c.hex, /^#[0-9A-F]{6}$/i, c.id);
});

test('на любом цвете палитры текст кнопки читается', () => {
  // Родитель выбирает цвет, а не пару «цвет + цвет букв»: контраст обязан
  // получаться сам. Порог 4.5:1 — обычное требование к тексту (WCAG AA).
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const c of PALETTE) {
    assert.ok(contrast(c.hex, readableInk(c.hex)) >= 4.5, `${c.id}: буквы на кнопке не читаются`);
  }
});

test('смешивание цветов: края и середина', () => {
  assert.equal(mixHex('#000000', '#FFFFFF', 0), '#000000');
  assert.equal(mixHex('#000000', '#FFFFFF', 1), '#FFFFFF');
  assert.equal(mixHex('#000000', '#FFFFFF', 0.5), '#808080');
  assert.equal(mixHex('#000000', '#FFFFFF', 5), '#FFFFFF', 'мусорная доля не ломает цвет');
});

test('CSS-переменные темы: все на месте и все — цвета', () => {
  const vars = themeCssVars(dino);
  for (const name of ['--primary', '--secondary', '--accent', '--bg', '--ink', '--card', '--line', '--muted', '--primary-ink']) {
    assert.match(vars[name], /^#[0-9A-F]{6}$/i, name);
  }
  assert.equal(vars['--primary'], PALETTE.find(c => c.id === 'grass').hex);
  // Фон и карточки — светлые: подложка считается от главного цвета, а не берётся сама по себе.
  assert.ok(luminance(vars['--bg']) > luminance(vars['--card']));
  assert.ok(luminance(vars['--card']) > luminance(vars['--line']));
});

test('нормализация: тема без id — не тема, мусор в цветах заменяется', () => {
  assert.equal(normalizeTheme(null), null);
  assert.equal(normalizeTheme({ name: 'Без id' }), null);
  const th = normalizeTheme({ id: 'x', name: '  Космос  ', colors: { primary: 'нет такого' }, ranks: ['А'] });
  assert.equal(th.name, 'Космос');
  assert.ok(PALETTE_IDS.includes(th.colors.primary));
  for (const role of COLOR_ROLES) assert.ok(PALETTE_IDS.includes(th.colors[role]), role);
  assert.equal(th.ranks.length, RANK_COUNT, 'рангов всегда четыре — по числу порогов');
  assert.equal(th.emoji.length <= 2, true, 'значок — один символ, а не строка');
});

test('список тем: без дублей, не длиннее четырёх, пустой — это пресеты', () => {
  assert.deepEqual(normalizeThemes([]).map(t => t.id), defaultThemes().map(t => t.id));
  assert.deepEqual(normalizeThemes(null).map(t => t.id), ['sunny', 'starry']);
  const many = normalizeThemes(Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, name: `Т${i}` })));
  assert.equal(many.length, MAX_THEMES);
  const dupes = normalizeThemes([{ id: 'a', name: 'Раз' }, { id: 'a', name: 'Два' }]);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].name, 'Раз', 'побеждает первая: она уже связана с коллекциями детей');
});

test('пресеты подписаны словарём, своя тема — своим именем', () => restore(() => {
  const [sunny] = defaultThemes();
  setLang('ru');
  const ru = resolveTheme(sunny).label;
  setLang('en');
  assert.notEqual(resolveTheme(sunny).label, ru, 'пресет переводится вместе с приложением');
  // Имя, которое вписал родитель, не переводится никогда — это его слово.
  assert.equal(resolveTheme(dino).label, 'Динозавры');
  setLang('ru');
  assert.equal(resolveTheme(dino).label, 'Динозавры');
}));

test('ранги темы: своё название где вписано, словарное — где пусто', () => {
  assert.deepEqual(themeRanks(dino), dino.ranks);
  const half = themeRanks({ ...dino, ranks: ['Яйцо', '', '', 'Тираннозавр'] });
  assert.equal(half[0], 'Яйцо');
  assert.equal(half[3], 'Тираннозавр');
  assert.ok(half[1].length > 2 && half[2].length > 2, 'дырок в лестнице рангов не бывает');
});

test('добавление темы: имя обязательно, четыре — потолок', () => {
  const one = [dino];
  assert.equal(addTheme(one, { name: '' }).error, 'name-required');
  assert.equal(addTheme(one, { name: 'динозавры' }).error, 'name-taken', 'регистр не делает тему новой');

  let list = one;
  for (const name of ['Космос', 'Котята', 'Море']) {
    const res = addTheme(list, { name });
    assert.equal(res.error, null, name);
    list = res.themes;
  }
  assert.equal(list.length, MAX_THEMES);
  assert.equal(canAddTheme(list), false);
  assert.equal(addTheme(list, { name: 'Пятая' }).error, 'limit');
  assert.deepEqual(one, [dino], 'вход не мутируется');
});

test('правка темы: id (а значит, и коллекция) переживает переименование', () => {
  const res = updateTheme([dino], 'dino', { name: 'Драконы', colors: { ...dino.colors, primary: 'coral' } });
  assert.equal(res.error, null);
  assert.equal(res.themes[0].id, 'dino', 'id — ключ коллекции карточек, его не трогаем');
  assert.equal(res.themes[0].name, 'Драконы');
  assert.equal(res.themes[0].colors.primary, 'coral');
  assert.equal(updateTheme([dino], 'нет такой', { name: 'X' }).error, 'not-found');
  // Переименованный пресет перестаёт быть пресетом: имя теперь родительское.
  const [sunny] = defaultThemes();
  const renamed = updateTheme([sunny], sunny.id, { name: 'Пчёлы' });
  assert.equal(renamed.themes[0].preset, null);
  assert.equal(resolveTheme(renamed.themes[0]).label, 'Пчёлы');
});

test('удаление темы: последнюю не отдаём', () => {
  assert.equal(removeTheme([dino], 'dino').error, 'last');
  const two = [dino, { id: 'space', name: 'Космос' }];
  const res = removeTheme(two, 'space');
  assert.equal(res.error, null);
  assert.deepEqual(res.themes.map(t => t.id), ['dino']);
  assert.equal(removeTheme(two, 'нет такой').error, 'not-found');
});

test('id темы: читаемый, стабильный, без кириллицы в пути', () => {
  assert.equal(makeThemeId('Динозавры', () => 0), 'theme-0', 'кириллица не в [a-z0-9] → безопасный слаг');
  assert.equal(makeThemeId('Space Cats', () => 0), 'space-cats-0');
  assert.match(makeThemeId('', () => 0), /^theme-/);
});

test('заготовка новой темы не повторяет цвета уже занятых', () => {
  const used = new Set([dino].flatMap(t => Object.values(t.colors)));
  const draft = draftTheme([dino]);
  for (const role of COLOR_ROLES) assert.ok(!used.has(draft.colors[role]), role);
  assert.ok(THEME_EMOJI.includes(draft.emoji));
  assert.equal(draft.name, '', 'имя придумывает родитель, а не мы');
  assert.equal(validateTheme(draft, [dino]), 'name-required');
});

test('старые франшизные id читаются как темы-пресеты', () => {
  assert.equal(migrateLegacyThemeId('minion'), 'sunny');
  assert.equal(migrateLegacyThemeId('jedi'), 'starry');
  assert.equal(migrateLegacyThemeId('dino'), 'dino');
  assert.equal(migrateLegacyThemeId(null), '');
});
