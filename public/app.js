(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.documentElement;

  /* ---------- contact (edit these two lines when you have a business mailbox) ---------- */
  var MAIL_USER = 'russ.wingfield', MAIL_HOST = 'gmail.com';

  /* ---------- theme ---------- */
  var KEY = 'ao-theme';
  try { var saved = localStorage.getItem(KEY); if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved); } catch (e) {}
  var themeBtn = $('#theme');
  function effective() {
    var a = root.getAttribute('data-theme');
    if (a) return a;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncTheme() {
    var dark = effective() === 'dark';
    $('.i-moon', themeBtn).hidden = dark;
    $('.i-sun', themeBtn).hidden = !dark;
    themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  themeBtn.addEventListener('click', function () {
    var next = effective() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
    syncTheme();
  });
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme); } catch (e) {}
  syncTheme();

  /* ---------- header + scroll spy ---------- */
  var top = $('#top');
  function onScroll() { top.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  var links = $$('.nav a');
  if ('IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          links.forEach(function (a) { a.setAttribute('aria-current', a.getAttribute('href') === '#' + en.target.id ? 'true' : 'false'); });
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    ['cases', 'about', 'engagements', 'contact'].forEach(function (id) { var s = document.getElementById(id); if (s) spy.observe(s); });
  }

  /* ---------- hero burn-up chart ---------- */
  var svg = $('#chart'), plot = $('#plot'), tip = $('#tip');
  var TODAY = 8, XMAX = 20, YMAX = 34;
  var SC = {
    opaque:  { done: [0, 0, 2, 3, 3, 8, 9, 9, 15],    rate: [2.0, 1.4, 0.9] },
    visible: { done: [0, 2, 4, 6, 8, 11, 13, 16, 19], rate: [3.0, 2.6, 2.2] }
  };
  var cur = { done: [0, 0, 0, 0, 0, 0, 0, 0, 0], rate: SC.visible.rate.slice() };
  var name = 'visible', hover = null, raf = 0, W = 0, H = 0;
  function scopeAt(w) { return w >= 5 ? 30 : 24; }
  function reach(d, r) { return TODAY + (30 - d) / r; }
  function endpoint(d, r, rate) { return r <= XMAX ? [r, 30] : [XMAX, d + rate * (XMAX - TODAY)]; }

  function draw() {
    var box = plot.clientWidth;
    if (!box) return;
    W = Math.max(280, box);
    H = Math.round(Math.min(380, Math.max(250, W * 0.62)));
    var m = { l: 34, r: W < 480 ? 46 : 54, t: 14, b: 34 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var x = function (w) { return m.l + (w / XMAX) * iw; };
    var y = function (v) { return m.t + ih - (v / YMAX) * ih; };
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    var h = '';
    [0, 10, 20, 30].forEach(function (v) {
      h += '<line class="g" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
           '<text class="t" x="' + (m.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    });
    [0, 4, 8, 12, 16, 20].forEach(function (w) {
      h += '<text class="t" x="' + x(w) + '" y="' + (H - m.b + 18) + '" text-anchor="middle">' + w + '</text>';
    });
    h += '<text class="t" x="' + (W - m.r) + '" y="' + (H - 2) + '" text-anchor="end">weeks</text>';

    var d8 = cur.done[TODAY], r = cur.rate;
    var eo = endpoint(d8, reach(d8, r[0]), r[0]);
    var em = endpoint(d8, reach(d8, r[1]), r[1]);
    var ep = endpoint(d8, reach(d8, r[2]), r[2]);
    var poly = [[TODAY, d8], eo];
    if (eo[1] >= 30 && ep[0] > eo[0]) poly.push([Math.min(ep[0], XMAX), 30]);
    if (ep[1] < 30) poly.push(ep);
    h += '<polygon class="cone" points="' + poly.map(function (p) { return x(p[0]) + ',' + y(p[1]); }).join(' ') + '"/>';
    h += '<line class="fc" x1="' + x(TODAY) + '" y1="' + y(d8) + '" x2="' + x(em[0]) + '" y2="' + y(em[1]) + '"/>';
    h += '<line class="today" x1="' + x(TODAY) + '" x2="' + x(TODAY) + '" y1="' + y(0) + '" y2="' + (m.t - 4) + '"/>';
    h += '<text class="t" x="' + (x(TODAY) + 6) + '" y="' + (m.t + 6) + '">today</text>';

    h += '<path class="scope" d="M' + x(0) + ' ' + y(24) + 'H' + x(5) + 'V' + y(30) + 'H' + x(XMAX) + '"/>';
    h += '<text class="lab-scope" x="' + (W - m.r + 6) + '" y="' + (y(30) + 4) + '">scope</text>';

    var d = cur.done.map(function (v, i) { return (i ? 'L' : 'M') + x(i) + ' ' + y(v); }).join('');
    h += '<path class="done" d="' + d + '"/>';
    h += '<circle class="pt" cx="' + x(TODAY) + '" cy="' + y(d8) + '" r="5"/>';
    h += '<text class="lab-done" x="' + (x(TODAY) - 10) + '" y="' + (y(d8) - 12) + '" text-anchor="end">done</text>';

    if (hover !== null) {
      var hv = cur.done[hover];
      h += '<line class="xh" x1="' + x(hover) + '" x2="' + x(hover) + '" y1="' + y(0) + '" y2="' + y(YMAX) + '"/>' +
           '<circle class="pt" cx="' + x(hover) + '" cy="' + y(hv) + '" r="5"/>';
      tip.textContent = 'Week ' + hover + ': ' + Math.round(hv) + ' of ' + scopeAt(hover) + ' done';
      tip.style.left = Math.min(W - 70, Math.max(70, x(hover))) + 'px';
      tip.style.top = (y(hv) + 12) + 'px';
      tip.classList.add('on');
    } else {
      tip.classList.remove('on');
    }
    svg.innerHTML = h;
    svg._geo = { m: m, iw: iw };
  }

  function readouts() {
    var s = SC[name], d8 = s.done[TODAY];
    var lo = Math.ceil(reach(d8, s.rate[0])), hi = Math.ceil(reach(d8, s.rate[2]));
    var spread = hi - lo;
    $('#r-today').textContent = d8 + ' of 30 done';
    $('#r-window').textContent = 'Weeks ' + lo + '–' + hi;
    $('#r-spread').textContent = spread + (spread === 1 ? ' week' : ' weeks');
    svg.setAttribute('aria-label', 'Burn-up chart of work done against scope over twenty weeks. ' +
      (name === 'visible' ? 'With visible delivery, ' : 'With delivery in the dark, ') +
      d8 + ' of 30 items are done at week 8 and the forecast finish is between weeks ' + lo + ' and ' + hi + '. Use the arrow keys to inspect each week.');
  }

  function go(next) {
    name = next;
    $('#sc-visible').setAttribute('aria-pressed', next === 'visible');
    $('#sc-opaque').setAttribute('aria-pressed', next === 'opaque');
    var to = SC[next], from = { done: cur.done.slice(), rate: cur.rate.slice() };
    var dur = reduce ? 0 : 750, t0 = null;
    cancelAnimationFrame(raf);
    function step(ts) {
      if (t0 === null) t0 = ts;
      var k = dur ? Math.min(1, (ts - t0) / dur) : 1, e = 1 - Math.pow(1 - k, 3), i;
      for (i = 0; i < cur.done.length; i++) cur.done[i] = from.done[i] + (to.done[i] - from.done[i]) * e;
      for (i = 0; i < 3; i++) cur.rate[i] = from.rate[i] + (to.rate[i] - from.rate[i]) * e;
      draw();
      if (k < 1) raf = requestAnimationFrame(step); else readouts();
    }
    raf = requestAnimationFrame(step);
  }
  $('#sc-visible').addEventListener('click', function () { go('visible'); });
  $('#sc-opaque').addEventListener('click', function () { go('opaque'); });

  function setHover(w) { hover = w; draw(); }
  svg.addEventListener('pointermove', function (e) {
    if (!svg._geo) return;
    var g = svg._geo, rect = svg.getBoundingClientRect();
    var w = Math.round(((e.clientX - rect.left) - g.m.l) / g.iw * XMAX);
    setHover(w >= 0 && w <= TODAY ? w : null);
  });
  svg.addEventListener('pointerleave', function () { if (document.activeElement !== svg) setHover(null); });
  svg.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      var w = hover === null ? TODAY : hover;
      setHover(Math.max(0, Math.min(TODAY, w + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'Escape') { setHover(null); }
  });
  svg.addEventListener('blur', function () { setHover(null); });
  if ('ResizeObserver' in window) new ResizeObserver(function () { draw(); }).observe(plot);
  else window.addEventListener('resize', draw);
  readouts();
  go('visible');

  /* ---------- results: tick marks + count-up ---------- */
  var ticks = $('#ticks');
  if (ticks) {
    function row(label, n, cls) {
      var s = '<div class="' + (cls || '') + '"><span>' + label + '</span><svg viewBox="0 0 520 18" preserveAspectRatio="none">';
      for (var i = 0; i < n; i++) s += '<rect x="' + (n === 1 ? 0 : 4 + i * (512 / (n - 1))) + '" y="3" width="4" height="12" rx="1"/>';
      return s + '</svg></div>';
    }
    ticks.innerHTML = row('Monthly', 12) + row('Fortnightly', 26, 'new');
  }
  function fmt(v, dec, sign) {
    var s = dec ? Math.abs(v).toFixed(dec) : String(Math.abs(Math.round(v)));
    if (v < 0) return '−' + s;
    return (sign && v > 0 ? '+' : '') + s;
  }
  function count(el) {
    var to = parseFloat(el.dataset.to), from = parseFloat(el.dataset.from || '0'),
        dec = parseInt(el.dataset.dec || '0', 10), sign = !!el.dataset.sign, t0 = null, dur = 1100;
    function step(ts) {
      if (t0 === null) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e, dec, sign);
      if (k < 1) requestAnimationFrame(step); else el.textContent = fmt(to, dec, sign);
    }
    requestAnimationFrame(step);
  }
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { count(en.target); io.unobserve(en.target); } });
    }, { threshold: 0.6 });
    $$('.count').forEach(function (c) { io.observe(c); });
  }

  /* ---------- contact ---------- */
  var addr = MAIL_USER + '@' + MAIL_HOST;
  $('#mail-link').setAttribute('href', 'mailto:' + addr + '?subject=' + encodeURIComponent('Agile Outcomes enquiry'));
  $('#mail-text').textContent = addr;
  $('#copy').addEventListener('click', function () {
    var done = function (ok) {
      var c = $('#copied'); c.textContent = ok ? 'Copied' : 'Select the address and copy it';
      setTimeout(function () { c.textContent = ''; }, 2400);
      if (!ok) { var r = document.createRange(); r.selectNodeContents($('#mail-text')); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
    };
    try { navigator.clipboard.writeText(addr).then(function () { done(true); }, function () { done(false); }); }
    catch (e) { done(false); }
  });
  $('#yr').textContent = new Date().getFullYear();
})();
