// When BOLD LLM writes the home letters, and so which letter is the current one: one file for the server
// (home-letter.js, bold-llm.js) and the home page (copied to assets/js/letter-due.js by eleventy.config.js, as merge.js).
// Plain ES5, no dependencies: BoldLetterDue in a page, require('./letter-due') here.
(function(root, make){
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.BoldLetterDue = make();
})(typeof self !== 'undefined' ? self : this, function(){
  // How often (settings/homeLetter.refresh, Settings › BOLD Agent): the hours (London) the letters are written at.
  var REFRESH = { daily: [5], twice: [5, 13], working: [5, 9, 12, 15, 18] };
  function refreshHours(r){ return REFRESH[r] || REFRESH.daily; }
  // When the letters were last due (ms): the latest of r's hours (London) at or before now, today's or else
  // yesterday's last.
  function lastDue(r, now){
    now = now || Date.now();
    var p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(now)).forEach(function(x){ p[x.type] = Number(x.value); });
    var hours = refreshHours(r), past = hours.filter(function(h){ return h <= p.hour; });
    var back = past.length ? p.hour - past[past.length - 1] : p.hour + 24 - hours[hours.length - 1];
    return now - (now % 1000) - ((back * 60 + p.minute) * 60 + p.second) * 1000;
  }
  // The current letter: written since the letters were last due (a letter from yesterday afternoon isn't this morning's).
  function isFresh(doc, r, now){ return !!(doc && doc.at && doc.at >= lastDue(r, now)); }
  return { REFRESH: REFRESH, refreshHours: refreshHours, lastDue: lastDue, isFresh: isFresh };
});
