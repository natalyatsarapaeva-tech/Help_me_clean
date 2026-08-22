/* «Наведи и убери» — PWA bootstrap (не модуль; регистрирует service worker).
 * Перенос Twin pwa.js: при смене контролирующего SW — один reload, чтобы сразу
 * подтянулся свежий код (важно на iOS-PWA, где старый кэш залипает).
 */
(function () {
  if (!('serviceWorker' in navigator)) return;
  var reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (reloaded) return;
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
