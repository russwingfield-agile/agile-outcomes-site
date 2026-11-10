/* Live delivery dashboard. Loads /api/flow once the page is ready and draws five SVG charts with real axes.
   Everything is computed server-side; this file only draws and writes text. No libraries. */
(function () {
  'use strict';
  var sec = document.getElementById('showcase');
  if (!sec) return;
  var NS = 'http://www.w3.org/2000/svg';
  var DAY = 86400000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var data = null, drawn = false;

  /* ---------- helpers ---------- */
  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function text(parent, x, y, str, cls, anchor, rot) {
    var t = el('text', { x: x, y: y, class: cls || 'ax', 'text-anchor': anchor || 'start', transform: rot ? 'rotate(' + rot + ' ' + x + ' ' + y + ')' : null }, parent);
    t.textContent = str; return t;
  }
  function set(id, v) { var n = document.getElementById(id); if (n) n.textContent = v; }
  function num(v) { return v == null ? '–' : Number(v).toLocaleString('en-GB'); }
  function days(v) { return v == null ? '–' : (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-GB')) + ' days'; }
  function dmy(iso) { var d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
  function dmyFull(iso) { var d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function niceStep(max, n) { var raw = max / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
  function linearTicks(max, n) { var step = niceStep(max, n || 4), out = []; for (var v = 0; v <= max + step * 0.001; v += step) out.push(v); if (out[out.length - 1] < max) out.push(out[out.length - 1] + step); return out; }
  function logTicks(lo, hi) { var out = []; for (var v = lo; v <= hi * 1.0001; v *= 10) out.push(v); return out; }
  function tickLabel(v) { return v >= 1 ? v.toLocaleString('en-GB') : String(v); }
  function aria(id, str) { var s = document.querySelector('#' + id + ' svg'); if (s) s.setAttribute('aria-label', str); }

  /* ---------- canvas, tooltip, axes ---------- */
  function setup(id, h) {
    var host = document.getElementById(id);
    var w = Math.max(280, Math.floor(host.clientWidth || 320));
    host.textContent = '';
    var svg = el('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, role: 'img' });
    host.appendChild(svg);
    var tip = document.createElement('div'); tip.className = 'ptip'; tip.hidden = true; host.appendChild(tip);
    host.onpointermove = function (e) {
      var t = e.target.closest && e.target.closest('[data-tip]');
      if (!t) { tip.hidden = true; return; }
      tip.textContent = t.getAttribute('data-tip'); tip.hidden = false;
      var r = host.getBoundingClientRect();
      var x = Math.min(Math.max(e.clientX - r.left, 90), r.width - 90);
      tip.style.left = x + 'px'; tip.style.top = Math.max(e.clientY - r.top - 12, 8) + 'px';
    };
    host.onpointerleave = function () { tip.hidden = true; };
    return { svg: svg, w: w, h: h, m: { l: 62, r: 14, t: 12, b: 62 } };
  }
  // o = { xTicks: [[px, label]], yTicks: [[py, label]], xTitle, yTitle, noGridX }
  function axes(s, o) {
    var m = s.m, g = el('g', { class: 'axes' }, s.svg);
    o.yTicks.forEach(function (t) {
      el('line', { x1: m.l, x2: s.w - m.r, y1: t[0], y2: t[0], class: 'gl' }, g);
      text(g, m.l - 8, t[0] + 4, t[1], 'ax', 'end');
    });
    var base = s.h - m.b;
    el('line', { x1: m.l, x2: s.w - m.r, y1: base, y2: base, class: 'axl' }, g);
    el('line', { x1: m.l, x2: m.l, y1: m.t, y2: base, class: 'axl' }, g);
    o.xTicks.forEach(function (t) {
      el('line', { x1: t[0], x2: t[0], y1: base, y2: base + 5, class: 'axl' }, g);
      String(t[1]).split('|').forEach(function (line, k) { text(g, t[0], base + 19 + k * 13, line, 'ax', t.length > 2 ? t[2] : 'middle'); });
    });
    if (o.yTitle) text(g, 14, m.t + (base - m.t) / 2, o.yTitle, 'axt', 'middle', -90);
    if (o.xTitle) text(g, m.l + (s.w - m.l - m.r) / 2, s.h - 8, o.xTitle, 'axt', 'middle');
    return g;
  }
  function plotH(w) { return w < 520 ? 270 : 330; }

  /* ---------- 1. Throughput ---------- */
  function drawThroughput(d) {
    var t = d.throughput, host = document.getElementById('p-tp');
    var s = setup('p-tp', plotH(host.clientWidth)), m = s.m;
    var maxV = Math.max.apply(null, t.weeks.map(function (w) { return w.count; }));
    var yt = linearTicks(maxV * 1.08, 4), top = yt[yt.length - 1];
    var ih = s.h - m.t - m.b, iw = s.w - m.l - m.r, n = t.weeks.length, bw = iw / n;
    var y = function (v) { return m.t + ih - (v / top) * ih; };
    var every = s.w < 520 ? 6 : 4, xt = [];
    t.weeks.forEach(function (w, i) { if (i % every === 0) xt.push([m.l + i * bw + bw / 2, dmy(w.week)]); });
    axes(s, { yTicks: yt.map(function (v) { return [y(v), num(v)]; }), xTicks: xt, yTitle: 'Items resolved per week', xTitle: 'Week commencing' });
    t.weeks.forEach(function (w, i) {
      var hh = (w.count / top) * ih;
      el('rect', { x: m.l + i * bw + bw * 0.16, y: y(w.count), width: bw * 0.68, height: Math.max(hh, 0), rx: 2, class: 'cbar' + (w.partial ? ' part' : ''),
        'data-tip': 'Week of ' + dmyFull(w.week) + ': ' + w.count + ' resolved' + (w.partial ? ' so far (week in progress)' : '') }, s.svg);
    });
    var last = n - 2;
    el('line', { x1: m.l + bw / 2, y1: y(t.trend.intercept), x2: m.l + last * bw + bw / 2, y2: y(t.trend.intercept + t.trend.slope * last), class: 'trend' }, s.svg);
    var f = d.facts.throughput;
    set('r-tp-4', f.last4WeeksAverage + ' a week'); set('r-tp-8', f.previous8WeeksAverage + ' a week'); set('r-tp-avg', f.weeklyAverage26 + ' a week');
    aria('p-tp', 'Bar chart of items resolved per week over 26 weeks. Average over the last four weeks ' + f.last4WeeksAverage + ', previous eight weeks ' + f.previous8WeeksAverage + '. Trend line ' + (t.trend.slope >= 0 ? 'rising' : 'falling') + '.');
  }

  /* ---------- 2. Lead time over time ---------- */
  function drawLead(d) {
    var L = d.leadTime, host = document.getElementById('p-lt');
    var s = setup('p-lt', plotH(host.clientWidth) + 10), m = s.m;
    var ih = s.h - m.t - m.b, iw = s.w - m.l - m.r, n = L.weekly.length;
    var lo = 0.1, hi = 10000, ly = function (v) { return Math.log10(Math.max(v, lo)); };
    var y = function (v) { return m.t + ih - ((ly(v) - ly(lo)) / (ly(hi) - ly(lo))) * ih; };
    var first = Date.parse(L.weekly[0].week + 'T00:00:00Z'), span = n * 7 * DAY;
    var x = function (ms) { return m.l + ((ms - first) / span) * iw; };
    var every = s.w < 520 ? 6 : 4, xt = [];
    L.weekly.forEach(function (w, i) { if (i % every === 0) xt.push([x(Date.parse(w.week + 'T00:00:00Z') + 3.5 * DAY), dmy(w.week)]); });
    axes(s, { yTicks: logTicks(lo, hi).map(function (v) { return [y(v), tickLabel(v)]; }), xTicks: xt, yTitle: 'Days to resolve (log scale)', xTitle: 'Week of resolution' });
    L.points.forEach(function (p) { el('circle', { cx: x(p[0] * 60000), cy: y(p[1]), r: 1.8, class: 'pt faint' }, s.svg); });
    function series(key, cls) {
      var path = '', pen = false;
      L.weekly.forEach(function (w, i) {
        if (w[key] == null) { pen = false; return; }
        path += (pen ? 'L' : 'M') + (m.l + (i + 0.5) * (iw / n)).toFixed(1) + ',' + y(w[key]).toFixed(1); pen = true;
      });
      el('path', { d: path, class: 'ln ' + cls }, s.svg);
      L.weekly.forEach(function (w, i) {
        if (w[key] == null) return;
        el('circle', { cx: m.l + (i + 0.5) * (iw / n), cy: y(w[key]), r: 3, class: 'mk ' + cls }, s.svg);
      });
    }
    series('p85', 'sc'); series('p50', 'ac');
    // one wide invisible target per week, so the tooltip reads both lines at once
    L.weekly.forEach(function (w, i) {
      el('rect', { x: m.l + i * (iw / n), y: m.t, width: iw / n, height: ih, fill: 'transparent',
        'data-tip': 'Week of ' + dmyFull(w.week) + ': ' + (w.p50 == null ? 'too few items to measure' : 'median ' + days(w.p50) + ', 85th percentile ' + days(w.p85)) + ' (' + w.n + ' items)' }, s.svg);
    });
    var f = d.facts.leadTimeDays;
    set('r-lt-4', days(f.medianLast4Weeks)); set('r-lt-8', days(f.medianPrevious8Weeks)); set('r-lt-p85', days(f.p85Of26Weeks));
    aria('p-lt', 'Chart of lead time in days by week, on a log scale. Median over the last four weeks ' + days(f.medianLast4Weeks) + ', previous eight weeks ' + days(f.medianPrevious8Weeks) + '. Over 26 weeks, 85% of items were resolved within ' + days(f.p85Of26Weeks) + '.');
  }

  /* ---------- 3. Work in progress by age ---------- */
  var STATUS_SHORT = { 'In Progress': 'Progress', 'In Review': 'Review', 'Waiting for Release': 'Release' };
  var STATUS = { 'In Progress': 'In progress', 'In Review': 'In review', 'Waiting for Release': 'Awaiting release' };
  function drawAge(d) {
    var A = d.age, L = d.leadTime, host = document.getElementById('p-age');
    var s = setup('p-age', plotH(host.clientWidth)), m = s.m;
    var order = ['In Progress', 'In Review', 'Waiting for Release'], cols = [];
    A.items.forEach(function (i) { if (cols.indexOf(i.status) < 0) cols.push(i.status); });
    cols.sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib); });
    if (!cols.length) { text(s.svg, s.w / 2, s.h / 2, 'Nothing is in progress right now', 'ax', 'middle'); return; }
    var ih = s.h - m.t - m.b, iw = s.w - m.l - m.r, lo = 1, hi = 10000;
    var y = function (v) { return m.t + ih - (Math.log10(Math.max(v, lo)) / Math.log10(hi)) * ih; };
    var cw = iw / cols.length;
    // threshold bands, drawn first so the points sit on top
    var yP50 = y(L.p50), yP85 = y(L.p85);
    el('rect', { x: m.l, y: yP50, width: iw, height: y(lo) - yP50, class: 'band ok' }, s.svg);
    el('rect', { x: m.l, y: yP85, width: iw, height: yP50 - yP85, class: 'band mid' }, s.svg);
    el('rect', { x: m.l, y: m.t, width: iw, height: yP85 - m.t, class: 'band late' }, s.svg);
    axes(s, { yTicks: logTicks(lo, hi).map(function (v) { return [y(v), tickLabel(v)]; }),
      xTicks: cols.map(function (c, i) { var n = A.items.filter(function (it) { return it.status === c; }).length; return [m.l + i * cw + cw / 2, ((s.w < 520 ? STATUS_SHORT : STATUS)[c] || c) + '|' + n + (n === 1 ? ' item' : ' items')]; }),
      yTitle: 'Days since raised (log scale)', xTitle: 'Current status' });
    [[L.p50, 'median lead time', ''], [L.p85, '85th percentile', 'd1']].forEach(function (k) {
      el('line', { x1: m.l, x2: s.w - m.r, y1: y(k[0]), y2: y(k[0]), class: 'pl ' + k[2] }, s.svg);
      text(s.svg, s.w - m.r - 4, y(k[0]) - 5, k[1] + ' ' + days(k[0]), 'pl-t', 'end');
    });
    var a = 0, b = 0, c = 0;
    cols.forEach(function (col, ci) {
      A.items.filter(function (it) { return it.status === col; }).forEach(function (it, k) {
        var late = it.age > L.p85; if (it.age <= L.p50) a++; else if (!late) b++; else c++;
        var jitter = ((k * 37) % 100) / 100 - 0.5;
        el('circle', { cx: m.l + ci * cw + cw / 2 + jitter * (cw * 0.6), cy: y(it.age), r: 4.2, class: 'pt' + (late ? ' late' : ''),
          'data-tip': 'Item #' + it.id + ': ' + (STATUS[col] || col).toLowerCase() + ', raised ' + days(it.age) + ' ago' }, s.svg);
      });
    });
    set('r-age-n', num(A.count)); set('r-age-a', num(a)); set('r-age-b', num(b)); set('r-age-c', num(c));
    aria('p-age', A.count + ' items are in progress. ' + a + ' are younger than the median lead time, ' + b + ' are between the median and the 85th percentile, and ' + c + ' are older than the 85th percentile.');
  }

  /* ---------- 3b. Cumulative flow, from each item's status history ---------- */
  function drawCFD(d) {
    var C = d.cfd, host = document.getElementById('p-cfd');
    var s = setup('p-cfd', plotH(host.clientWidth) + 20), m = s.m;
    var D = C.days, n = D.length, ih = s.h - m.t - m.b, iw = s.w - m.l - m.r, last = D[n - 1];
    var total = function (p) { return p.todo + p.doing + p.done; };
    var yt = linearTicks(total(last) * 1.04, 4), top = yt[yt.length - 1];
    var y = function (v) { return m.t + ih - (v / top) * ih; }, x = function (i) { return m.l + (i / (n - 1)) * iw; };
    var xt = [], stepD = s.w < 520 ? 56 : 28;
    for (var i = n - 1; i >= 0; i -= stepD) xt.unshift([x(i), dmy(D[i].day)]);
    axes(s, { yTicks: yt.map(function (v) { return [y(v), num(v)]; }), xTicks: xt, yTitle: 'Items raised in the period', xTitle: 'Date' });
    // bottom to top: done, in progress, not started
    function band(lo, hi, cls) {
      var up = D.map(function (p, i) { return x(i).toFixed(1) + ',' + y(hi(p)).toFixed(1); });
      var dn = D.map(function (p, i) { return x(i).toFixed(1) + ',' + y(lo(p)).toFixed(1); }).reverse();
      el('polygon', { points: up.concat(dn).join(' '), class: 'cf ' + cls }, s.svg);
    }
    band(function () { return 0; }, function (p) { return p.done; }, 'done');
    band(function (p) { return p.done; }, function (p) { return p.done + p.doing; }, 'doing');
    band(function (p) { return p.done + p.doing; }, total, 'todo');
    var cross = el('line', { y1: m.t, y2: m.t + ih, class: 'cross', visibility: 'hidden' }, s.svg);
    var hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, s.svg);
    hit.addEventListener('pointermove', function (e) {
      var r = s.svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - m.l) / iw) * (n - 1)))), p = D[i];
      hit.setAttribute('data-tip', dmyFull(p.day) + ': ' + num(p.done) + ' done, ' + num(p.doing) + ' in progress, ' + num(p.todo) + ' not started');
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    });
    hit.addEventListener('pointerleave', function () { cross.setAttribute('visibility', 'hidden'); });
    var f = d.facts.cumulativeFlow;
    set('r-cf-raised', num(f.itemsRaisedInWindow)); set('r-cf-done', num(f.doneNow) + ' (' + f.doneSharePercent + '%)'); set('r-cf-doing', num(f.inProgressNow)); set('r-cf-todo', num(f.notStartedNow));
    aria('p-cfd', 'Cumulative flow of the ' + num(f.itemsRaisedInWindow) + ' items raised in the last 26 weeks. Today ' + num(f.doneNow) + ' are done, ' + num(f.inProgressNow) + ' are in progress and ' + num(f.notStartedNow) + ' have not started.');
  }

  /* ---------- 3c. Work in progress over time: how many, and how old ---------- */
  function drawWip(d) {
    var W = d.wip.weeks, n = W.length, host = document.getElementById('p-wip');
    var h = host.clientWidth < 520 ? 210 : 230;
    var every = host.clientWidth < 520 ? 6 : 4;
    function frame(id, top, label, tickFmt) {
      var s = setup(id, h), m = s.m, ih = s.h - m.t - m.b, iw = s.w - m.l - m.r, bw = iw / n;
      var yt = linearTicks(top, 3); top = yt[yt.length - 1];
      var y = function (v) { return m.t + ih - (v / top) * ih; }, x = function (i) { return m.l + (i + 0.5) * bw; };
      var xt = []; W.forEach(function (w, i) { if (i % every === 0) xt.push([x(i), dmy(w.week)]); });
      axes(s, { yTicks: yt.map(function (v) { return [y(v), tickFmt(v)]; }), xTicks: xt, yTitle: label, xTitle: 'Week commencing' });
      return { s: s, m: m, ih: ih, iw: iw, bw: bw, y: y, x: x };
    }
    function path(g, key) {
      var d = '', pen = false;
      W.forEach(function (w, i) { if (w[key] == null) { pen = false; return; } d += (pen ? 'L' : 'M') + g.x(i).toFixed(1) + ',' + g.y(w[key]).toFixed(1); pen = true; });
      return d;
    }
    function targets(g, tip) {
      W.forEach(function (w, i) { el('rect', { x: g.m.l + i * g.bw, y: g.m.t, width: g.bw, height: g.ih, fill: 'transparent', 'data-tip': tip(w) }, g.s.svg); });
    }
    var maxW = Math.max.apply(null, W.map(function (w) { return w.wip; })) * 1.1 || 1;
    var a = frame('p-wip', maxW, 'Items', num);
    var area = 'M' + a.x(0).toFixed(1) + ',' + a.y(0).toFixed(1) + W.map(function (w, i) { return 'L' + a.x(i).toFixed(1) + ',' + a.y(w.wip).toFixed(1); }).join('') + 'L' + a.x(n - 1).toFixed(1) + ',' + a.y(0).toFixed(1) + 'Z';
    el('path', { d: area, class: 'wipa' }, a.s.svg);
    el('path', { d: path(a, 'wip'), class: 'wipl' }, a.s.svg);
    el('circle', { cx: a.x(n - 1), cy: a.y(W[n - 1].wip), r: 3.6, class: 'mk', stroke: 'var(--cf-doing)' }, a.s.svg);
    targets(a, function (w) { return 'Week of ' + dmyFull(w.week) + ': ' + w.wip + ' in progress' + (w.partial ? ' (so far this week)' : ''); });

    var maxA = Math.max.apply(null, W.map(function (w) { return w.p85 || 0; })) * 1.1 || 10;
    var b = frame('p-wage', maxA, 'Days', num);
    el('path', { d: path(b, 'p85'), class: 'ln sc', 'stroke-dasharray': '6 4' }, b.s.svg);
    el('path', { d: path(b, 'p50'), class: 'ln ac' }, b.s.svg);
    targets(b, function (w) { return 'Week of ' + dmyFull(w.week) + ': ' + (w.p50 == null ? 'too few items to measure' : 'median age ' + days(w.p50) + ', 85th percentile ' + days(w.p85)); });

    var f = d.facts.workInProgress.overTime;
    set('r-wp-now', num(f.itemsNow)); set('r-wp-ago', num(f.itemsFourWeeksAgo)); set('r-wp-age', days(f.medianAgeNowDays)); set('r-wp-agoage', days(f.medianAgeFourWeeksAgoDays));
    aria('p-wip', 'Items in progress each week over 26 weeks, between ' + num(f.lowestItems) + ' and ' + num(f.peakItems) + '. ' + num(f.itemsNow) + ' now, against ' + num(f.itemsFourWeeksAgo) + ' four weeks ago.');
    aria('p-wage', 'Median and 85th percentile age of items in progress, by week. Median age now ' + days(f.medianAgeNowDays) + ', against ' + days(f.medianAgeFourWeeksAgoDays) + ' four weeks ago.');
  }

  /* ---------- 4. Flow ---------- */
  function drawFlow(d) {
    var F = d.flow, host = document.getElementById('p-flow');
    var s = setup('p-flow', plotH(host.clientWidth)), m = s.m;
    var ih = s.h - m.t - m.b, iw = s.w - m.l - m.r, n = F.days.length, last = F.days[n - 1];
    var yt = linearTicks(Math.max(last.arrived, last.departed) * 1.05, 4), top = yt[yt.length - 1];
    var y = function (v) { return m.t + ih - (v / top) * ih; }, x = function (i) { return m.l + (i / (n - 1)) * iw; };
    var xt = [], stepD = s.w < 520 ? 56 : 28;
    for (var i = n - 1; i >= 0; i -= stepD) xt.unshift([x(i), dmy(F.days[i].day)]);
    axes(s, { yTicks: yt.map(function (v) { return [y(v), num(v)]; }), xTicks: xt, yTitle: 'Cumulative items', xTitle: 'Date' });
    var ap = F.days.map(function (p, i) { return x(i).toFixed(1) + ',' + y(p.arrived).toFixed(1); }), dp = F.days.map(function (p, i) { return x(i).toFixed(1) + ',' + y(p.departed).toFixed(1); });
    el('polygon', { points: ap.join(' ') + ' ' + dp.slice().reverse().join(' '), class: 'gap' + (last.departed > last.arrived ? ' shrink' : '') }, s.svg);
    el('polyline', { points: ap.join(' '), class: 'ln sc' }, s.svg);
    el('polyline', { points: dp.join(' '), class: 'ln ac' }, s.svg);
    var cross = el('line', { y1: m.t, y2: m.t + ih, class: 'cross', visibility: 'hidden' }, s.svg);
    var hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, s.svg);
    hit.addEventListener('pointermove', function (e) {
      var r = s.svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - m.l) / iw) * (n - 1))));
      hit.setAttribute('data-tip', dmyFull(F.days[i].day) + ': ' + num(F.days[i].arrived) + ' raised, ' + num(F.days[i].departed) + ' resolved');
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    });
    hit.addEventListener('pointerleave', function () { cross.setAttribute('visibility', 'hidden'); });
    var f = d.facts.flow;
    set('r-fl-arr', num(last.arrived)); set('r-fl-dep', num(last.departed));
    set('r-fl-net', (F.netChange > 0 ? '+' : F.netChange < 0 ? '−' : '') + num(Math.abs(F.netChange)) + (F.netChange > 0 ? ' (growing)' : F.netChange < 0 ? ' (shrinking)' : ''));
    aria('p-flow', 'Cumulative items raised and resolved over 26 weeks. ' + num(f.raisedLast26Weeks) + ' raised and ' + num(f.resolvedLast26Weeks) + ' resolved.');
  }

  /* ---------- 5. Forecast against delivery, over time ---------- */
  function drawForecast(d) {
    var f = d.forecast, host = document.getElementById('p-fc');
    if (!f || !f.history.length) { host.textContent = 'There is not enough recent history to forecast.'; return; }
    var H = f.history, s = setup('p-fc', plotH(host.clientWidth)), m = s.m;
    var ih = s.h - m.t - m.b, iw = s.w - m.l - m.r, n = H.length;
    var maxV = Math.max.apply(null, H.map(function (h) { return Math.max(h.p95, h.actual || 0); }));
    var yt = linearTicks(maxV * 1.08, 4), top = yt[yt.length - 1];
    var y = function (v) { return m.t + ih - (v / top) * ih; }, x = function (i) { return m.l + (i + 0.5) * (iw / n); };
    var every = s.w < 520 ? 3 : 2, xt = [];
    H.forEach(function (h, i) { if ((n - 1 - i) % every === 0) xt.push([x(i), dmy(h.week)]); });
    axes(s, { yTicks: yt.map(function (v) { return [y(v), num(v)]; }), xTicks: xt, yTitle: 'Items resolved in the next 4 weeks', xTitle: 'Forecast made in week commencing' });
    function poly(hiK, loK, cls) {
      var up = H.map(function (h, i) { return x(i).toFixed(1) + ',' + y(h[hiK]).toFixed(1); }), dn = H.map(function (h, i) { return x(i).toFixed(1) + ',' + y(h[loK]).toFixed(1); }).reverse();
      el('polygon', { points: up.concat(dn).join(' '), class: cls }, s.svg);
    }
    poly('p95', 'p5', 'band2'); poly('p85', 'p15', 'band1');
    el('polyline', { points: H.map(function (h, i) { return x(i).toFixed(1) + ',' + y(h.p50).toFixed(1); }).join(' '), class: 'ln ac thin' }, s.svg);
    var pts = H.map(function (h, i) { return h.actual == null ? null : [x(i), y(h.actual)]; });
    el('polyline', { points: pts.filter(Boolean).map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '), class: 'ln act' }, s.svg);
    H.forEach(function (h, i) {
      if (h.actual != null) el('circle', { cx: x(i), cy: y(h.actual), r: 3.6, class: 'mk act' }, s.svg);
      el('rect', { x: m.l + i * (iw / n), y: m.t, width: iw / n, height: ih, fill: 'transparent',
        'data-tip': 'Forecast from week of ' + dmyFull(h.week) + ': median ' + h.p50 + ', 15th to 85th percentile ' + h.p15 + ' to ' + h.p85 + (h.actual == null ? '. Outcome not complete yet' : '. Delivered ' + h.actual) }, s.svg);
    });
    var o = f.outcomes;
    set('r-fc-50', num(o.atLeast50) + ' items'); set('r-fc-85', num(o.atLeast85) + ' items'); set('r-fc-95', num(o.atLeast95) + ' items');
    set('r-fc-held', f.calibration.atLeast85Held + ' of ' + f.calibration.judged + ' (at the 85% level)');
    aria('p-fc', 'Chart of past four-week forecasts against what was delivered. The latest forecast is a median of ' + o.atLeast50 + ' items, with 85% confidence of at least ' + o.atLeast85 + '.');
  }

  /* ---------- headline figures and commentary ---------- */
  function delta(id, change, lowerBetter, vs) {
    var n = document.getElementById(id); if (!n) return;
    if (change == null) { n.textContent = ''; n.className = 'd'; return; }
    var up = change > 0, flat = Math.abs(change) < 5, good = lowerBetter ? !up : up;
    n.textContent = (flat ? '≈ ' : up ? '▲ ' : '▼ ') + Math.abs(change).toFixed(1).replace(/\.0$/, '') + '% ' + vs;
    n.className = 'd ' + (flat ? 'flat' : good ? 'good' : 'warn');
  }
  function headline(d) {
    var f = d.facts;
    set('k-tp', f.throughput.last4WeeksAverage + ' a week'); delta('k-tp-d', f.throughput.changeVsPreviousPercent, false, 'vs previous 8 weeks');
    set('k-lt', days(f.leadTimeDays.medianLast4Weeks)); delta('k-lt-d', f.leadTimeDays.medianChangePercent, true, 'vs previous 8 weeks');
    set('k-wip', num(f.workInProgress.itemsInProgress)); set('k-wip-d', f.workInProgress.itemsOlderThanP85LeadTime + ' beyond the 85th percentile');
    var net = f.flow.netChangeLast30Days;
    set('k-net', (net > 0 ? '+' : net < 0 ? '−' : '') + num(Math.abs(net))); set('k-net-d', num(f.flow.raisedLast30Days) + ' raised, ' + num(f.flow.resolvedLast30Days) + ' resolved');
    set('sc-period', 'Last ' + f.period.weeks + ' weeks, ' + dmy(f.period.from) + ' to ' + dmyFull(f.period.to));
  }
  var MAP = { overall: 'in-overall', throughput: 'in-tp', leadTime: 'in-lt', workInProgress: 'in-age', cumulativeFlow: 'in-cfd', flow: 'in-flow', forecast: 'in-fc', summary: 'in-summary' };
  function commentary(d) {
    var ins = d.insights;
    // with status history the work-in-progress commentary belongs to the over-time chart
    var map = {}; Object.keys(MAP).forEach(function (k) { map[k] = MAP[k]; });
    if (hasHistory(d)) map.workInProgress = 'in-wip';
    ['in-age', 'in-wip', 'in-cfd'].forEach(function (id) { var b = document.getElementById(id); if (b && Object.keys(map).every(function (k) { return map[k] !== id; })) b.hidden = true; });
    Object.keys(map).forEach(function (k) {
      var box = document.getElementById(map[k]); if (!box) return;
      var p = box.querySelector('.in-t');
      if (ins && ins[k]) { p.textContent = ins[k]; box.hidden = false; } else box.hidden = true;
    });
    var sum = document.getElementById('sum-box'); if (sum) sum.hidden = !(ins && ins.summary);
    set('sc-gen', ins ? 'Commentary is generated from the figures above and refreshed every few minutes.' : '');
  }

  /* ---------- load, draw, redraw ---------- */
  function state(name) { sec.setAttribute('data-state', name); }
  function hasHistory(d) { return !!(d.cfd && d.wip && d.facts && d.facts.cumulativeFlow && d.facts.workInProgress.overTime); }
  function draw() {
    if (!data) return;
    // The status-history charts replace the snapshot by age when the history is available; otherwise the snapshot stays.
    var hist = hasHistory(data);
    ['cfd-card', 'wip-card'].forEach(function (id) { var c = document.getElementById(id); if (c) c.hidden = !hist; });
    var old = document.getElementById('age-card'); if (old) old.hidden = hist;
    (hist ? [drawThroughput, drawLead, drawCFD, drawWip, drawFlow, drawForecast] : [drawThroughput, drawLead, drawAge, drawFlow, drawForecast]).forEach(function (f) { try { f(data); } catch (e) { if (window.console) console.error(f.name, e); } });
    drawn = true;
  }
  function show(j) {
    data = j; state('ready'); headline(j); draw(); commentary(j);
    var when = new Date(j.generatedAt);
    set('sc-updated', 'Updated ' + when.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
    if (!j.insights) poll(0);
  }
  // The first visit after a quiet spell gets the numbers straight away and the commentary a few seconds later.
  function poll(n) {
    if (n >= 3) return;
    setTimeout(function () {
      fetchFlow(true).then(function (k) { if (k.insights) { data.insights = k.insights; commentary(data); } else poll(n + 1); }).catch(function () {});
    }, 9000);
  }
  function fetchFlow(fresh) {
    return fetch('/api/flow', { headers: { Accept: 'application/json' }, cache: fresh ? 'reload' : 'default' }).then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); });
  }
  function load() { state('loading'); fetchFlow(false).then(show).catch(function () { state('error'); }); }
  var retry = document.getElementById('sc-retry'); if (retry) retry.addEventListener('click', load);
  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (drawn) draw(); }, 150); });

  // The home page has already warmed the data, so this is usually instant.
  if (document.readyState === 'complete') load(); else window.addEventListener('load', load);
})();
