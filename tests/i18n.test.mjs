// Тесты локализации (node --test, без Firebase/DOM).
//
// Смысл файла: «переведено полностью» — это свойство, которое ломается тихо.
// Забытый ключ не падает, он просто показывает английскую строку посреди
// русского экрана (или наоборот). Поэтому полноту словарей проверяем машинно, а
// не глазами.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGS, DEFAULT_LANG, DICT, LANG_CHIPS, LANG_PROMPT_NAMES, LANG_TAGS,
  t, tList, getLang, setLang, normalizeLang, adoptFamilyLang, onLangChange,
} from '../js/i18n.js';
import {
  actionCategory, ACTION_IDS, zoneKind, ZONE_IDS, theme, themeIds,
  ROOM_TYPES, roomTypeLabel, rankForCleanups, tidyStandard, verifyLimitsText,
  missedPhrase,
} from '../js/family-core.js';
import { PALETTE_IDS, paletteLabel } from '../js/themes-core.js';
import { BONUS_TASKS } from '../js/bonus-core.js';

const restore = (fn) => { const was = getLang(); try { return fn(); } finally { setLang(was); } };

test('в каждом языке ровно те же ключи — забытый перевод виден сразу', () => {
  const base = new Set(Object.keys(DICT[DEFAULT_LANG]));
  assert.ok(base.size > 200, 'словарь не выродился');
  for (const lang of LANGS) {
    const keys = new Set(Object.keys(DICT[lang]));
    const missing = [...base].filter(k => !keys.has(k));
    const extra = [...keys].filter(k => !base.has(k));
    assert.deepEqual(missing, [], `${lang}: не переведено`);
    assert.deepEqual(extra, [], `${lang}: ключи, которых нет в ${DEFAULT_LANG}`);
  }
});

test('пустых и «переведённых в ключ» строк нет', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(DICT[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key}`);
      assert.ok(value.trim().length, `${lang}.${key}: пустая строка`);
      assert.notEqual(value, key, `${lang}.${key}: значение совпало с ключом`);
    }
  }
});

test('подстановки одинаковые в обоих языках — иначе {name} вылезет на экран', () => {
  const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const key of Object.keys(DICT[DEFAULT_LANG])) {
    const want = holes(DICT[DEFAULT_LANG][key]);
    for (const lang of LANGS) {
      assert.deepEqual(holes(DICT[lang][key]), want, `${key} (${lang})`);
    }
  }
});

test('у каждого языка есть чип, имя для промпта и BCP-47 тег', () => {
  for (const lang of LANGS) {
    assert.ok(LANG_CHIPS[lang], lang);
    assert.ok(LANG_PROMPT_NAMES[lang], lang);
    assert.match(LANG_TAGS[lang], /^[a-z]{2}-[A-Z]{2}$/, lang);
  }
});

test('t: подстановка, неизвестный ключ, неизвестная подстановка', () => restore(() => {
  setLang('en');
  assert.equal(t('scan.stepOf', { n: 2, of: 5 }), 'Step 2 of 5');
  assert.equal(t('нет.такого.ключа'), 'нет.такого.ключа', 'ключ виден, а не пустая строка');
  assert.match(t('scan.stepOf', { n: 2 }), /\{of\}/, 'недоданное поле остаётся как есть — заметно');
}));

test('tList собирает нумерованные ключи по порядку и не уходит в бесконечность', () => restore(() => {
  setLang('en');
  const std = tList('tidy.standard');
  assert.equal(std.length, tidyStandard().length);
  assert.ok(std.length >= 5);
  assert.deepEqual(tList('нет.такого'), []);
}));

test('normalizeLang принимает только известное', () => {
  assert.equal(normalizeLang('RU'), 'ru');
  assert.equal(normalizeLang('en-GB'), 'en');
  assert.equal(normalizeLang('fr'), null);
  assert.equal(normalizeLang(undefined), null);
});

test('setLang зовёт подписчиков ровно на настоящую смену', () => restore(() => {
  setLang('en');
  const seen = [];
  const off = onLangChange(l => seen.push(l));
  setLang('ru');
  setLang('ru');        // то же самое — события быть не должно
  setLang('klingon');   // неизвестный — игнорируем
  off();
  setLang('en');        // после отписки не приходит
  assert.deepEqual(seen, ['ru']);
}));

test('язык семьи не перебивает выбор, сделанный на устройстве', () => restore(() => {
  // В Node localStorage нет, поэтому «выбора на устройстве» тоже нет — язык
  // семьи применяется. Это ровно поведение второго планшета из коробки.
  setLang('en');
  assert.equal(adoptFamilyLang('ru'), 'ru');
  assert.equal(adoptFamilyLang('фигня'), 'ru', 'мусор из базы ничего не меняет');
}));

// ── Доменные подписи: переведено ВСЁ, что видит человек ─────────────────────
test('у каждой категории действия есть инструкция и цель в каждом языке', () => restore(() => {
  for (const lang of LANGS) {
    setLang(lang);
    for (const id of ACTION_IDS) {
      const c = actionCategory(id);
      assert.ok(c.instruction.length > 5, `${lang}/${id}: инструкция`);
      assert.ok(c.target.length > 1, `${lang}/${id}: цель`);
      assert.ok(c.color && c.emoji, `${lang}/${id}: цвет и эмодзи не зависят от языка`);
    }
  }
}));

test('у каждого вида очага есть название и строка плана в каждом языке', () => restore(() => {
  for (const lang of LANGS) {
    setLang(lang);
    for (const id of ZONE_IDS) {
      const z = zoneKind(id);
      assert.ok(z.name && z.plan, `${lang}/${id}`);
    }
    // «Протереть» — единственный очаг со своим текстом: категории для него нет.
    assert.ok(zoneKind('wipe').instruction && zoneKind('wipe').target, lang);
    assert.equal(zoneKind('chair').instruction, undefined, 'у остальных текст берётся от категории');
  }
}));

test('образы, ранги и типы комнат подписаны в каждом языке', () => restore(() => {
  for (const lang of LANGS) {
    setLang(lang);
    for (const id of themeIds()) {
      const th = theme(id);
      assert.ok(th.label && th.currencyName && th.praiseWord, `${lang}/${id}`);
      assert.ok(th.currencyEmoji, `${lang}/${id}: эмодзи валюты вне языка`);
    }
    for (const rt of ROOM_TYPES) assert.ok(roomTypeLabel(rt).length > 2, `${lang}/${rt}`);
    for (const n of [0, 8, 25, 60]) assert.ok(rankForCleanups(n).length > 2, `${lang}/${n}`);
  }
}));

test('двенадцать цветов палитры названы в каждом языке', () => restore(() => {
  // Цвет выбирают на слух («давай оранжевую тему»), а не пипеткой: без подписи
  // палитра — это ряд квадратиков, о которых не договориться.
  for (const lang of LANGS) {
    setLang(lang);
    const labels = PALETTE_IDS.map(paletteLabel);
    for (const [i, label] of labels.entries()) assert.ok(label.length > 2, `${lang}/${PALETTE_IDS[i]}`);
    assert.equal(new Set(labels).size, labels.length, `${lang}: два цвета названы одинаково`);
  }
}));

test('бонусные задания переведены целиком', () => restore(() => {
  for (const lang of LANGS) {
    setLang(lang);
    for (const task of BONUS_TASKS) {
      assert.ok(task.title.length > 5, `${lang}/${task.id}: title`);
      assert.ok(task.hint.length > 10, `${lang}/${task.id}: hint`);
      assert.ok(task.check.length > 10, `${lang}/${task.id}: check`);
    }
  }
}));

test('переключение языка меняет подписи, id остаются прежними', () => restore(() => {
  setLang('en');
  const en = { action: actionCategory('trash').instruction, rank: rankForCleanups(30), theme: theme('starry').label };
  setLang('ru');
  const ru = { action: actionCategory('trash').instruction, rank: rankForCleanups(30), theme: theme('starry').label };
  for (const key of Object.keys(en)) assert.notEqual(en[key], ru[key], key);
  assert.equal(actionCategory('trash').id, 'trash', 'id — данные, они не переводятся');
}));

test('планка проверки подставляет число, а не оставляет {others}', () => restore(() => {
  for (const lang of LANGS) {
    setLang(lang);
    const text = verifyLimitsText();
    assert.ok(!text.includes('{'), `${lang}: незакрытая подстановка`);
    assert.ok(text.includes('3'), `${lang}: допуск виден числом`);
  }
}));

test('перечисление оставшегося склеивается на языке интерфейса', () => restore(() => {
  const left = [{ todo: 'a' }, { todo: 'b' }];
  setLang('en');
  assert.equal(missedPhrase(left), 'a and b');
  assert.equal(missedPhrase([{ label: 'socks' }]), 'put away: socks');
  setLang('ru');
  assert.equal(missedPhrase(left), 'a и b');
  assert.equal(missedPhrase([{ label: 'носки' }]), 'убрать: носки');
}));
