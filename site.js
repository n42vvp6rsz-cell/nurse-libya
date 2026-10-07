'use strict';
(() => {
  const app = window.NurseApp;
  if (!app) return;
  const updateTitle = () => {
    const heading = document.querySelector('.screen:not([hidden]) h1');
    document.title = heading?.textContent ? `${heading.textContent} | نيرس ليبيا` : 'نيرس ليبيا | خدمات التمريض والرعاية';
  };
  app.onReady(updateTitle);
  window.addEventListener('hashchange', () => queueMicrotask(updateTitle));
})();
