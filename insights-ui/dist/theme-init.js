// Sets the theme class before the first paint: the remembered choice, else the system setting.
(function () {
  var choice = null;
  try { choice = localStorage.getItem('insights.theme'); } catch (e) { choice = null; }
  if (choice !== 'light' && choice !== 'dark') {
    choice = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.className = 'theme-' + choice;
})();
