/* A gallery page in the theme tool (index.html shows it in a frame per theme). ?theme=dark
   sets the dark theme as base.njk does, before anything paints; the tool then writes its
   edits into the <style id="themeEdits"> at the end of <head>. */
(function(){
  if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  document.write('<style id="themeEdits"></style>');
  // In the tool's frame, which is sized to fit the page: no scrollbar of its own.
  if (window.top !== window) document.documentElement.style.overflowY = 'hidden';
  // Links and buttons here go nowhere.
  document.addEventListener('click', function(e){ if (e.target.closest('a, button')) e.preventDefault(); });
  document.addEventListener('submit', function(e){ e.preventDefault(); });
})();
