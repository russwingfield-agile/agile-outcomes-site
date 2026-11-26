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

  /* ---------- header ---------- */
  var top = $('#top');
  function onScroll() { top.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  /* ---------- mobile menu ---------- */
  var menuBtn = $('#menu');
  function setMenu(open) {
    top.classList.toggle('menu-open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  if (menuBtn) {
    menuBtn.addEventListener('click', function () { setMenu(!top.classList.contains('menu-open')); });
    $$('.nav a').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && top.classList.contains('menu-open')) { setMenu(false); menuBtn.focus(); }
    });
  }

  /* ---------- scroll spy (home page: About and Contact) ---------- */
  var home = document.body.getAttribute('data-page') === 'home';
  if (home && 'IntersectionObserver' in window) {
    var links = $$('.nav a[href^="/#"]');
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          links.forEach(function (a) { a.setAttribute('aria-current', a.getAttribute('href') === '/#' + en.target.id ? 'true' : 'false'); });
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    ['about', 'contact'].forEach(function (id) { var s = document.getElementById(id); if (s) spy.observe(s); });
  }

  $('#yr').textContent = new Date().getFullYear();

  /* Warm the Worker and the browser cache so the live dashboard opens with its data ready. */
  if (home) (window.requestIdleCallback || function (f) { setTimeout(f, 1500); })(function () { try { fetch('/api/flow').catch(function () {}); } catch (e) {} });

  /* ---------- live demos page: pick a demo (/demo/#backlog, /demo/#outcomes; default Delivery) ---------- */
  var dtabs = $$('.dtab'), dpanels = $$('[data-demo]:not(.dtab)');
  if (dtabs.length) {
    var pick = function (id, push) {
      dpanels.forEach(function (p) { p.hidden = p.getAttribute('data-demo') !== id; });
      dtabs.forEach(function (t) { t.setAttribute('aria-pressed', t.getAttribute('data-demo') === id ? 'true' : 'false'); });
      if (push) { try { history.replaceState(null, '', id === 'delivery' ? location.pathname : '#' + id); } catch (e) {} }
      window.dispatchEvent(new Event('resize')); /* the dashboard redraws to its real width */
    };
    var fromHash = function () { var h = location.hash.slice(1); pick(h === 'backlog' || h === 'outcomes' ? h : 'delivery', false); };
    dtabs.forEach(function (t) { t.addEventListener('click', function () { pick(t.getAttribute('data-demo'), true); }); });
    window.addEventListener('hashchange', fromHash);
    fromHash();
  }

  /* ---------- results: count-up ---------- */
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
  /* Any link with data-mail="Subject" becomes a mailto link to the address above. */
  $$('[data-mail]').forEach(function (a) { a.setAttribute('href', 'mailto:' + addr + '?subject=' + encodeURIComponent(a.getAttribute('data-mail'))); });
  var mailLink = $('#mail-link');
  if (!mailLink) return;
  mailLink.setAttribute('href', 'mailto:' + addr + '?subject=' + encodeURIComponent('Agile Outcomes enquiry'));
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
})();
