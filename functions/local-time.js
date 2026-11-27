// Each person's own timezone, the one their Slack profile has (people/{slackId}.tz, an IANA name): one file for
// the server (whether a reminder's hour has come where they are) and the pages (a London meeting's time where they
// are; copied to assets/js/local-time.js by eleventy.config.js, as merge.js).
// Plain ES5, no dependencies: BoldLocalTime in a page, require('./local-time') here.
(function(root, make){
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.BoldLocalTime = make();
})(typeof self !== 'undefined' ? self : this, function(){
  // Meetings are entered and kept in London time, and whoever has no timezone on Slack is taken to be there.
  var LONDON = 'Europe/London';
  var DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  var fmts = {};
  function fmt(tz){
    return fmts[tz] || (fmts[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }
  // Pure: `tz` if it's a timezone this runtime knows, else London.
  function zone(tz){
    if (!tz || typeof tz !== 'string') return LONDON;
    try { fmt(tz); return tz; } catch (e){ return LONDON; }
  }
  function numbers(tz, ms){
    var p = {};
    fmt(zone(tz)).formatToParts(new Date(ms)).forEach(function(x){ p[x.type] = Number(x.value); });
    p.hour = p.hour % 24;
    return p;
  }
  var pad = function(n){ return (n < 10 ? '0' : '') + n; };
  function dayOf(date){ return DAYS[new Date(date + 'T12:00:00Z').getUTCDay()]; }
  function addDays(date, n){ var d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  // Pure: the clock in `tz` at `ms` → { date: 'YYYY-MM-DD', day: 'MO'…, hour, minute, time: 'HH:MM' }.
  function at(tz, ms){
    var p = numbers(tz, ms), date = p.year + '-' + pad(p.month) + '-' + pad(p.day);
    return { date: date, day: dayOf(date), hour: p.hour, minute: p.minute, time: pad(p.hour) + ':' + pad(p.minute) };
  }
  // Pure: how far `tz`'s clock is ahead of UTC at `ms`, in ms.
  function offset(tz, ms){
    var p = numbers(tz, ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (ms - ms % 1000);
  }
  // Pure: the instant (ms) a clock in `tz` shows `date` ('YYYY-MM-DD') and `time` ('HH:MM').
  function instant(date, time, tz){
    var wall = Date.parse(date + 'T' + time + ':00Z');
    // Twice: the first guess can fall on the other side of a change of clocks.
    return wall - offset(tz, wall - offset(tz, wall));
  }
  // Pure: is it `hour` o'clock (any minute of that hour) in `tz` at `ms`, on `day` ('MO'…) if one is given?
  // What a reminder due at that hour checks, run every hour: true once a day (or week) for each timezone.
  function isHour(tz, hour, ms, day){
    var c = at(tz, ms);
    return c.hour === hour && (!day || c.day === day);
  }
  // Pure: a weekly meeting { day, time, minutes }, kept in London time, as it falls in `tz` → { day, time, end,
  // differs }: from its next date on or after `now`, since the two places' clocks don't always change together.
  // `differs` is false where the clock reads the same as London's (then day, time and end are London's).
  function meetingIn(m, tz, now){
    var mins = Number(m && m.minutes) || 0;
    if (!m || !/^\d\d:\d\d$/.test(m.time || '') || DAYS.indexOf(m.day) < 0) return { day: m && m.day, time: m && m.time, end: '', differs: false };
    var t = m.time.split(':').map(Number), e = t[0] * 60 + t[1] + mins;
    var london = { day: m.day, time: m.time, end: pad(Math.floor(e / 60) % 24) + ':' + pad(e % 60), differs: false };
    if (zone(tz) === LONDON) return london;
    var d = at(LONDON, now).date;
    while (dayOf(d) !== m.day) d = addDays(d, 1);
    var start = instant(d, m.time, LONDON), a = at(tz, start);
    if (a.day === m.day && a.time === m.time) return london;
    return { day: a.day, time: a.time, end: at(tz, start + mins * 60000).time, differs: true };
  }
  // Pure: one London date and time as it falls in `tz` → { date, day, time }.
  function fromLondon(date, time, tz){ return at(tz, instant(date, time, LONDON)); }
  return { LONDON: LONDON, zone: zone, at: at, instant: instant, isHour: isHour, meetingIn: meetingIn, fromLondon: fromLondon };
});
