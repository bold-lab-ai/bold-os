(function(root){
  'use strict';
  function escape(value){return String(value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function formatText(value){
    var text=String(value),pattern=/https:\/\/[^\s<>"']+/g,result='',start=0,match;
    while((match=pattern.exec(text))){
      var candidate=match[0].replace(/[),.;]+$/,''),url;
      result+=escape(text.slice(start,match.index));
      try{url=new URL(candidate);}catch(e){url=null;}
      if(url&&url.protocol==='https:'&&!url.username&&!url.password){
        result+='<a href="'+escape(candidate)+'" target="_blank" rel="noopener noreferrer">'+escape(candidate)+'</a>'+escape(match[0].slice(candidate.length));
      }else result+=escape(match[0]);
      start=pattern.lastIndex;
    }
    return result+escape(text.slice(start));
  }
  // Defaults used until an administrator saves the service addresses in Settings › Problem Bank.
  var defaults = Object.freeze({
    autokaggleUrl: 'https://ecc962fa-2f4c-4a3f-96c4-179af273fb7a.k8s.civo.com/',
    autokaggleLiteUrl: 'https://lite.ecc962fa-2f4c-4a3f-96c4-179af273fb7a.k8s.civo.com/lite'
  });
  function serviceUrl(value){
    if (typeof value !== 'string') return '';
    try {
      var url = new URL(value);
      var localDemo = root.BOLD_TEST && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
      if ((!localDemo && url.protocol !== 'https:') || url.username || url.password) return '';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch (e){ return ''; }
  }
  async function loadServiceUrls(){
    var snap = await firebase.firestore(BOLD.getApp()).collection('settings').doc('problemBank').get();
    var saved = snap.exists ? snap.data() : {};
    return {
      autokaggleUrl: saved.autokaggleUrl || defaults.autokaggleUrl,
      autokaggleLiteUrl: saved.autokaggleLiteUrl || defaults.autokaggleLiteUrl
    };
  }
  root.BOLDRegistryLinks={formatText:formatText, defaults:defaults, serviceUrl:serviceUrl, loadServiceUrls:loadServiceUrls};
})(window);
