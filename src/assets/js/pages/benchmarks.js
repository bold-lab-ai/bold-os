(function(){
  'use strict';
  var link = document.getElementById('openBenchmarkLite');
  var status = document.getElementById('benchmarkStatus');
  if (!link || !BOLD.getAuth()) return;
  var generation = 0;
  BOLD.onUser(async function(user){
    var request = ++generation;
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
    status.textContent = '';
    if (!user) return;
    var urls;
    try { urls = await BOLDRegistryLinks.loadServiceUrls(); }
    catch (e){
      if (generation === request) status.textContent = 'Could not load the AutoKaggle Lite address. Reload this page to try again.';
      return;
    }
    if (generation !== request) return;
    var href = BOLDRegistryLinks.serviceUrl(urls.autokaggleLiteUrl);
    if (!href){
      status.textContent = 'Ask an administrator to check the AutoKaggle Lite address in Settings under Problem Bank.';
      return;
    }
    link.href = href;
    link.removeAttribute('aria-disabled');
  });
})();
