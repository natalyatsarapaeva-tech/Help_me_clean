// Тема → CSS-переменные документа. Единственный файл, который знает и про тему,
// и про DOM: сами значения считает чистое ядро (js/themes-core.js), тестируемое
// в Node, а здесь только присваивание.
//
// Раньше палитра жила в styles.css селектором [data-theme="jedi"] — это годилось,
// пока тем было ровно две и обе наши. Теперь их придумывает семья (до четырёх,
// со своими цветами), и заранее написать для них CSS невозможно: переменные
// ставятся инлайном на <html> в момент отрисовки.
import { themeCssVars } from './themes-core.js';

// Ставит переменные темы и подкрашивает системную строку браузера (meta
// theme-color): на планшете в режиме PWA это видимая часть экрана.
export function applyThemeVars(themeLike, root = document.documentElement) {
  const vars = themeCssVars(themeLike?.palette ? { ...themeLike, colors: themeLike.palette } : themeLike);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  if (themeLike?.id) root.setAttribute('data-theme', themeLike.id);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', vars['--primary']);
  return vars;
}
