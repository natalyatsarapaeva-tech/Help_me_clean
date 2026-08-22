/* «Наведи и убери» — на время отладки service worker ОТКЛЮЧЁН.
 * PWA-кэш на GitHub Pages приводил к тому, что браузер отдавал старый код и
 * правки не подхватывались. Здесь мы НЕ регистрируем SW, а также удаляем ранее
 * установленный и чистим кэши, чтобы браузер всегда брал свежую версию.
 * Вернём офлайн-оболочку позже, когда сетап заработает. */
(function () {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations()
    .then(function (regs) { regs.forEach(function (r) { r.unregister(); }); })
    .catch(function () {});
  if (window.caches && caches.keys) {
    caches.keys().then(function (keys) { keys.forEach(function (k) { caches.delete(k); }); }).catch(function () {});
  }
})();
