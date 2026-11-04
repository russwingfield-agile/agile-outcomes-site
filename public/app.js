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
