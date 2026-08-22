/* «Наведи и убери» — PWA bootstrap (не модуль; регистрирует service worker).
 * Перенос Twin pwa.js: при смене контролирующего SW — один reload, чтобы сразу
 * подтянулся свежий код (важно на iOS-PWA, где старый кэш залипает).
 *
 * Если понадобится снова отлаживать «залипший» код — временно заменить тело на
 * unregister() + caches.delete(), как делали при настройке Firebase.
 */
(function () {
  if (!('serviceWorker' in navigator)) return;
  var reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (reloaded) return;
    // Но НЕ посреди раунда: перезагрузка на экране уборки стирает подсветку,
    // счётчик и незаписанные искорки — ребёнок теряет заход из-за выкатки.
    // Экран уборки поднимает window.__tidyBusy на время раунда; свежий код
    // подтянется на следующем переходе, ждать он может.
    if (window.__tidyBusy) { window.__tidyReloadPending = true; return; }
    reloaded = true;
    window.location.reload();
  });
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      reg.update();
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state === 'installed' && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        });
      });
    }).catch(function (err) { console.warn('[pwa] sw registration failed:', err); });
  });
})();
