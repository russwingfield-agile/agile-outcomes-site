/* Live flow-metrics showcase. Loads /api/flow (a Worker that reads the public Jira project JRACLOUD)
   as soon as the page loads, then draws five SVG panels. No libraries. */
(function () {
  'use strict';
  var sec = document.getElementById('showcase');
  if (!sec) return;
  var NS = 'http://www.w3.org/2000/svg';
  var DAY = 86400000;
  var data = null, drawn = false;

  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function text(parent, x, y, str, cls, anchor) {
    var t = el('text', { x: x, y: y, class: cls || 'ax', 'text-anchor': anchor || 'start' }, parent);
    t.textContent = str; return t;
  }
  function fmtDays(d) { return d == null ? '–' : d < 10 ? d.toFixed(1) : Math.round(d).toLocaleString('en-GB'); }
  function fmtDate(iso) { var d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; }
  function fmtMs(ms) { return fmtDate(new Date(ms).toISOString().slice(0, 10)); }
  function niceMax(v) { var p = Math.pow(10, Math.floor(Math.log10(v || 1))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }

  /* ---- shared plumbing: size, tooltip, empty svg ---- */
  function setup(id, h) {
    var host = document.getElementById(id);
    var w = Math.max(260, Math.floor(host.clientWidth || 320));
    host.textContent = '';
    var svg = el('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, role: 'img' });
    host.appendChild(svg);
    var tip = document.createElement('div'); tip.className = 'ptip'; tip.hidden = true; host.appendChild(tip);
    host.onpointermove = function (e) {
      var t = e.target.closest && e.target.closest('[data-tip]');
      if (!t) { tip.hidden = true; return; }
      tip.textContent = t.getAttribute('data-tip'); tip.hidden = false;
      var r = host.getBoundingClientRect();
      var x = Math.min(Math.max(e.clientX - r.left, 60), r.width - 60);
      tip.style.left = x + 'px'; tip.style.top = Math.max(e.clientY - r.top - 12, 8) + 'px';
    };
    host.onpointerleave = function () { tip.hidden = true; };
    return { svg: svg, w: w, h: h };
  }
  function frame(s, m, yTicks, yFmt, yOf) {
    var g = el('g', {}, s.svg);
    yTicks.forEach(function (v) {
      var y = yOf(v);
      el('line', { x1: m.l, x2: s.w - m.r, y1: y, y2: y, class: 'gl' }, g);
      text(g, m.l - 8, y + 4, yFmt ? yFmt(v) : v, 'ax', 'end');
    });
    return g;
  }
  function label(svg, id, str) { document.getElementById(id).setAttribute('aria-label', str); }
  function set(id, v) { var n = document.getElementById(id); if (n) n.textContent = v; }

  /* 1. Throughput ---------------------------------------------------- */
  function drawThroughput(d) {
    var t = d.throughput, s = setup('p-tp', 250), m = { l: 34, r: 10, t: 12, b: 28 };
    var max = niceMax(Math.max.apply(null, t.weeks.map(function (w) { return w.count; })) * 1.1);
    var ih = s.h - m.t - m.b, iw = s.w - m.l - m.r;
    var y = function (v) { return m.t + ih - (v / max) * ih; };
    frame(s, m, [0, max / 2, max], null, y);
    var n = t.weeks.length, bw = iw / n;
    t.weeks.forEach(function (w, i) {
      var x = m.l + i * bw, hh = (w.count / max) * ih;
      var r = el('rect', { x: x + bw * 0.14, y: y(w.count), width: bw * 0.72, height: Math.max(hh, 0), rx: 2, class: 'cbar' + (w.partial ? ' part' : ''),
        'data-tip': 'Week of ' + fmtDate(w.week) + ': ' + w.count + ' resolved' + (w.partial ? ' (week in progress)' : '') }, s.svg);
      if (i % Math.ceil(n / 6) === 0) text(s.svg, x + bw / 2, s.h - 8, fmtDate(w.week), 'ax', 'middle');
    });
    var full = n - 1;
    el('line', { x1: m.l + bw / 2, y1: y(t.trend.intercept), x2: m.l + (full - 1) * bw + bw / 2, y2: y(t.trend.intercept + t.trend.slope * (full - 1)), class: 'trend' }, s.svg);
    var dir = Math.abs(t.trend.slope) < 0.15 ? 'flat' : t.trend.slope > 0 ? 'rising' : 'falling';
    set('r-tp-avg', t.average + ' a week');
    set('r-tp-trend', dir.charAt(0).toUpperCase() + dir.slice(1) + ' (' + (t.trend.slope > 0 ? '+' : '') + t.trend.slope + ' each week)');
    label(s.svg, 'p-tp', 'Bar chart of issues resolved per week over the last 26 weeks, averaging ' + t.average + ' a week, trend ' + dir + '.');
  }

  /* 2. Lead time scatter -------------------------------------------- */
  function drawLead(d) {
    var L = d.leadTime, s = setup('p-lt', 270), m = { l: 44, r: 44, t: 12, b: 28 };
    var ih = s.h - m.t - m.b, iw = s.w - m.l - m.r;
    var now = Date.parse(d.generatedAt), t0 = now - L.windowDays * DAY;
    var lo = 0.1, hi = 10000, ly = function (v) { return Math.log10(Math.max(v, lo)); };
    var y = function (v) { return m.t + ih - ((ly(v) - ly(lo)) / (ly(hi) - ly(lo))) * ih; };
    var x = function (ms) { return m.l + ((ms - t0) / (now - t0)) * iw; };
    frame(s, m, [0.1, 1, 10, 100, 1000, 10000], function (v) { return v >= 1 ? v.toLocaleString('en-GB') : v; }, y);
    L.points.forEach(function (p) {
      el('circle', { cx: x(p[0] * 60000), cy: y(p[1]), r: 2.6, class: 'pt', 'data-tip': fmtMs(p[0] * 60000) + ': ' + fmtDays(p[1]) + ' days' }, s.svg);
    });
    [['p50', 'p50', ''], ['p85', 'p85', 'd1'], ['p95', 'p95', 'd2']].forEach(function (k) {
      var v = L[k[0]]; if (v == null) return;
      el('line', { x1: m.l, x2: s.w - m.r, y1: y(v), y2: y(v), class: 'pl ' + k[2] }, s.svg);
      text(s.svg, s.w - m.r + 5, y(v) + 4, k[1], 'pl-t', 'start');
    });
    text(s.svg, m.l, s.h - 8, fmtMs(t0), 'ax'); text(s.svg, s.w - m.r, s.h - 8, fmtMs(now), 'ax', 'end');
    set('r-lt-p50', fmtDays(L.p50) + ' days'); set('r-lt-p85', fmtDays(L.p85) + ' days'); set('r-lt-p95', fmtDays(L.p95) + ' days');
    set('r-lt-n', L.n.toLocaleString('en-GB') + ' issues, last ' + L.windowDays + ' days');
    label(s.svg, 'p-lt', 'Scatter of ' + L.n + ' resolved issues by days from raised to resolved, on a log scale. 50% resolved within ' + fmtDays(L.p50) + ' days, 85% within ' + fmtDays(L.p85) + ', 95% within ' + fmtDays(L.p95) + '.');
  }

  /* 3. Work item age ------------------------------------------------- */
  function drawAge(d) {
    var A = d.age, L = d.leadTime, s = setup('p-age', 270), m = { l: 44, r: 44, t: 12, b: 40 };
    var cols = []; A.items.forEach(function (i) { if (cols.indexOf(i.status) < 0) cols.push(i.status); });
    var order = ['In Progress', 'In Review', 'Waiting for Release'];
    cols.sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib); });
    if (!cols.length) { text(s.svg, s.w / 2, s.h / 2, 'Nothing in progress right now', 'ax', 'middle'); set('r-age-n', '0'); return; }
    var ih = s.h - m.t - m.b, iw = s.w - m.l - m.r, lo = 1, hi = 10000;
    var y = function (v) { return m.t + ih - ((Math.log10(Math.max(v, lo)) - 0) / (Math.log10(hi) - 0)) * ih; };
    frame(s, m, [1, 10, 100, 1000, 10000], function (v) { return v.toLocaleString('en-GB'); }, y);
    [['p50', ''], ['p85', 'd1']].forEach(function (k) {
      if (L[k[0]] == null) return;
      el('line', { x1: m.l, x2: s.w - m.r, y1: y(L[k[0]]), y2: y(L[k[0]]), class: 'pl ' + k[1] }, s.svg);
      text(s.svg, s.w - m.r + 5, y(L[k[0]]) + 4, k[0], 'pl-t');
    });
    var cw = iw / cols.length, over = 0;
    cols.forEach(function (c, ci) {
      var items = A.items.filter(function (i) { return i.status === c; });
      text(s.svg, m.l + ci * cw + cw / 2, s.h - 22, ({ 'Waiting for Release': 'Release wait', 'In Progress': 'In progress', 'In Review': 'In review' })[c] || c, 'ax', 'middle');
      text(s.svg, m.l + ci * cw + cw / 2, s.h - 8, items.length + ' items', 'ax2', 'middle');
      items.forEach(function (it, k) {
        var jitter = ((k * 37) % 100) / 100 - 0.5;
        var late = L.p85 != null && it.age > L.p85; if (late) over++;
        el('circle', { cx: m.l + ci * cw + cw / 2 + jitter * (cw * 0.7), cy: y(it.age), r: 3.6, class: 'pt' + (late ? ' late' : ''),
          'data-tip': it.key + ': ' + fmtDays(it.age) + ' days since raised, ' + it.status }, s.svg);
      });
    });
    set('r-age-n', A.count.toLocaleString('en-GB')); set('r-age-p50', fmtDays(A.p50) + ' days'); set('r-age-over', over + ' of ' + A.count);
    label(s.svg, 'p-age', A.count + ' issues currently in progress, grouped by status, with age in days on a log scale. ' + over + ' are older than the 85th percentile lead time.');
  }

  /* 4. Arrivals vs departures --------------------------------------- */
  function drawFlow(d) {
    var F = d.flow, s = setup('p-flow', 250), m = { l: 38, r: 66, t: 12, b: 28 };
    var ih = s.h - m.t - m.b, iw = s.w - m.l - m.r, n = F.days.length;
    var last = F.days[n - 1], max = niceMax(Math.max(last.arrived, last.departed) * 1.05);
    var y = function (v) { return m.t + ih - (v / max) * ih; }, x = function (i) { return m.l + (i / (n - 1)) * iw; };
    frame(s, m, [0, max / 2, max], null, y);
    var ap = F.days.map(function (p, i) { return x(i) + ',' + y(p.arrived); }), dp = F.days.map(function (p, i) { return x(i) + ',' + y(p.departed); });
    el('polygon', { points: ap.join(' ') + ' ' + dp.slice().reverse().join(' '), class: 'gap' + (last.departed > last.arrived ? ' shrink' : '') }, s.svg);
    el('polyline', { points: ap.join(' '), class: 'ln la' }, s.svg);
    el('polyline', { points: dp.join(' '), class: 'ln ld' }, s.svg);
    text(s.svg, x(n - 1) + 6, y(last.arrived) + (last.arrived >= last.departed ? 4 : 14), 'raised', 'pl-t');
    text(s.svg, x(n - 1) + 6, y(last.departed) + (last.arrived >= last.departed ? 14 : 4), 'resolved', 'pl-t2');
    text(s.svg, m.l, s.h - 8, fmtDate(F.days[0].day), 'ax'); text(s.svg, s.w - m.r, s.h - 8, fmtDate(last.day), 'ax', 'end');
    var hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, s.svg);
    hit.addEventListener('pointermove', function (e) {
      var r = s.svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - m.l) / iw) * (n - 1))));
      hit.setAttribute('data-tip', fmtDate(F.days[i].day) + ': ' + F.days[i].arrived + ' raised, ' + F.days[i].departed + ' resolved (cumulative)');
    });
    set('r-fl-arr', last.arrived.toLocaleString('en-GB')); set('r-fl-dep', last.departed.toLocaleString('en-GB'));
    set('r-fl-net', (F.netChange > 0 ? '+' : '') + F.netChange.toLocaleString('en-GB') + (F.netChange > 0 ? ' (queue growing)' : F.netChange < 0 ? ' (queue shrinking)' : ''));
    label(s.svg, 'p-flow', 'Cumulative issues raised and resolved over ' + F.windowDays + ' days. ' + last.arrived + ' raised and ' + last.departed + ' resolved.');
  }

  /* 5. Forecast ------------------------------------------------------ */
  function drawForecast(d) {
    var f = d.forecast, host = document.getElementById('p-fc');
    if (!f) { host.textContent = 'Not enough recent throughput to forecast.'; return; }
    var s = setup('p-fc', 220), m = { l: 10, r: 10, t: 22, b: 30 };
    var bars = f.histogram.bars, bin = f.histogram.bin, lo = bars[0][0], hi = bars[bars.length - 1][0] + bin;
    var maxN = Math.max.apply(null, bars.map(function (b) { return b[1]; }));
    var ih = s.h - m.t - m.b, iw = s.w - m.l - m.r;
    var x = function (v) { return m.l + ((v - lo) / (hi - lo)) * iw; };
    bars.forEach(function (b) {
      var h = (b[1] / maxN) * ih;
      el('rect', { x: x(b[0]) + 0.5, y: m.t + ih - h, width: Math.max(x(b[0] + bin) - x(b[0]) - 1, 1), height: h, class: 'cbar', 'data-tip': b[0] + ' to ' + (b[0] + bin - 1) + ' issues' }, s.svg);
    });
    [['atLeast95', 'd2', 95], ['atLeast85', 'd1', 85], ['atLeast50', '', 50]].forEach(function (k) {
      var v = f.outcomes[k[0]], xx = x(v);
      el('line', { x1: xx, x2: xx, y1: m.t - 4, y2: m.t + ih, class: 'pl ' + k[1] }, s.svg);
      text(s.svg, xx, m.t - 6, k[2] + '%', 'pl-t', 'middle');
    });
    [lo, Math.round((lo + hi) / 2), hi].forEach(function (v, i) { text(s.svg, x(v), s.h - 22, v, 'ax', i === 0 ? 'start' : i === 2 ? 'end' : 'middle'); });
    text(s.svg, s.w / 2, s.h - 8, 'Issues resolved in the next ' + f.horizonWeeks + ' weeks', 'ax2', 'middle');
    set('r-fc-50', f.outcomes.atLeast50); set('r-fc-85', f.outcomes.atLeast85); set('r-fc-95', f.outcomes.atLeast95);
    set('r-fc-target', 'Clearing ' + f.target + ' issues: ' + f.weeksToTarget.p50 + ' week' + (f.weeksToTarget.p50 === 1 ? '' : 's') + ' at 50%, ' + f.weeksToTarget.p85 + ' at 85%, ' + f.weeksToTarget.p95 + ' at 95%.');
    set('fc-basis', f.runs.toLocaleString('en-GB') + ' simulated runs from the last ' + f.basedOnWeeks + ' weeks of throughput');
    label(s.svg, 'p-fc', 'Distribution of simulated issues resolved in four weeks. 85% of runs resolve at least ' + f.outcomes.atLeast85 + '.');
  }

  /* ---- load, draw, redraw ---- */
  function state(name) { sec.setAttribute('data-state', name); }
  function draw() {
    if (!data) return;
    [drawThroughput, drawLead, drawAge, drawFlow, drawForecast].forEach(function (f) { try { f(data); } catch (e) { if (window.console) console.error(f.name, e); } });
    var when = new Date(data.generatedAt);
    set('sc-updated', 'Data as of ' + when.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ', refreshed every few minutes');
    set('sc-open', data.totals.open.toLocaleString('en-GB')); set('sc-res', data.totals.resolvedLast365.toLocaleString('en-GB'));
    drawn = true;
  }
  var pending = null;
  function load() {
    state('loading');
    if (!pending) pending = fetch('/api/flow', { headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('status ' + r.status); return r.json();
    });
    pending.then(function (j) { data = j; state('ready'); draw(); }).catch(function () { pending = null; state('error'); });
  }
  var retry = document.getElementById('sc-retry'); if (retry) retry.addEventListener('click', load);
  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (drawn) draw(); }, 150); });
  // Colours come from CSS variables, so a theme change needs no redraw.

  // Preload as soon as the page has loaded so the numbers are ready by the time the visitor scrolls here.
  if (document.readyState === 'complete') load(); else window.addEventListener('load', load);
})();
