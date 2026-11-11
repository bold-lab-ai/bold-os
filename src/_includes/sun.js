/* The Auto theme (bold.js mountTheme): light from sunrise to sunset in London, where the lab is, dark otherwise.
   Inlined at the top of every page (base.njk, 404.njk) so it's decided before anything paints; tests/sun.test.cjs.
   boldSun(t): that UTC day's { rise, set } in ms (the sunrise equation, to a minute or two).
   boldSunDark(t): is it dark at t? boldSunNext(t): when the theme next changes. Plain ES5. */
window.boldSun = function(t){
  var r = Math.PI / 180, lat = 51.5074, lon = -0.1278, day = 864e5;
  var n = Math.floor(t / day) - 10957;                 // days since 2000-01-01 (J2000, at noon)
  var J = n - lon / 360;                                // mean solar noon
  var M = (357.5291 + 0.98560028 * J) % 360;            // the sun's mean anomaly
  var C = 1.9148 * Math.sin(M * r) + 0.02 * Math.sin(2 * M * r) + 0.0003 * Math.sin(3 * M * r);
  var L = (M + C + 282.9372) % 360;                     // ecliptic longitude
  var T = J + 0.0053 * Math.sin(M * r) - 0.0069 * Math.sin(2 * L * r);   // solar transit
  var s = Math.sin(L * r) * Math.sin(23.4397 * r), c = Math.sqrt(1 - s * s);
  var w = Math.acos((Math.sin(-0.833 * r) - Math.sin(lat * r) * s) / (Math.cos(lat * r) * c)) / r / 360;
  var noon = (10957.5 + T) * day;
  return { rise: noon - w * day, set: noon + w * day };
};
window.boldSunDark = function(t){ var s = window.boldSun(t); return t < s.rise || t >= s.set; };
window.boldSunNext = function(t){ var s = window.boldSun(t); return t < s.rise ? s.rise : t < s.set ? s.set : window.boldSun(t + 864e5).rise; };
