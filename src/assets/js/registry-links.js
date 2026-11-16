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
  root.BOLDRegistryLinks={formatText:formatText};
})(window);
