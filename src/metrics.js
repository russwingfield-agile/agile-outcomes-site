// Pure flow-metric calculations. No network and no Worker APIs, so they can be tested with plain Node.
// Inputs are plain objects; nothing about people (assignees, reporters) is ever read or returned.

const DAY = 86400000;
const WEEKS = 26;

export function startOfWeekUTC(ms) {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}
const startOfDayUTC = (ms) => ms - (((ms % DAY) + DAY) % DAY);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r0 = (x) => (x == null ? null : Math.round(x));
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const pct = (now, before) => (before ? Math.round(((now - before) / before) * 1000) / 10 : null);

// Linear-interpolated percentile of an ascending array, p in 0..1.
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const sortedNums = (a) => a.slice().sort((x, y) => x - y);

// Small seeded PRNG so a cached forecast does not change on every refresh.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weekIndex(ms, first) { return Math.floor((startOfWeekUTC(ms) - first) / (7 * DAY)); }

export function throughput(resolved, now, weeks = WEEKS) {
  const thisWeek = startOfWeekUTC(now);
  const first = thisWeek - weeks * 7 * DAY;
  const buckets = [];
  for (let i = 0; i <= weeks; i++) buckets.push({ start: first + i * 7 * DAY, count: 0 });
  for (const r of resolved) { const i = weekIndex(r.resolved, first); if (i >= 0 && i < buckets.length) buckets[i].count++; }
  const out = buckets.map((b, i) => ({ week: iso(b.start), count: b.count, partial: i === buckets.length - 1 }));
  // Trend over complete weeks only (the current week is still filling up).
  const full = out.filter((w) => !w.partial);
  const n = full.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  full.forEach((w, x) => { sx += x; sy += w.count; sxy += x * w.count; sxx += x * x; });
  const slope = n > 1 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
  const intercept = n ? (sy - slope * sx) / n : 0;
  return {
    weeks: out,
    trend: { slope: Math.round(slope * 100) / 100, intercept: Math.round(intercept * 100) / 100 },
    median: percentile(sortedNums(full.map((w) => w.count)), 0.5),
    average: n ? r1(sy / n) : 0,
  };
}

// Lead time (raised to resolved, in days): every resolved item as a point, plus weekly median and 85th percentile.
export function leadTime(resolved, now, weeks = WEEKS) {
  const thisWeek = startOfWeekUTC(now);
  const first = thisWeek - weeks * 7 * DAY;
  const pts = resolved.filter((r) => r.resolved >= first && r.resolved <= now && r.resolved >= r.created)
    .map((r) => ({ t: r.resolved, d: (r.resolved - r.created) / DAY }));
  const byWeek = Array.from({ length: weeks }, () => []);
  for (const p of pts) { const i = weekIndex(p.t, first); if (i >= 0 && i < weeks) byWeek[i].push(p.d); }
  const weekly = byWeek.map((a, i) => {
    const s = sortedNums(a);
    return { week: iso(first + i * 7 * DAY), n: a.length, p50: a.length >= 5 ? r1(percentile(s, 0.5)) : null, p85: a.length >= 5 ? r1(percentile(s, 0.85)) : null };
  });
  const sorted = sortedNums(pts.map((p) => p.d));
  return {
    weeks,
    n: pts.length,
    p50: r1(percentile(sorted, 0.5)),
    p85: r1(percentile(sorted, 0.85)),
    p95: r1(percentile(sorted, 0.95)),
    weekly,
    points: pts.map((p) => [Math.round(p.t / 60000), Math.round(p.d * 100) / 100]), // [epoch minutes, days]
  };
}

// Open items in progress, aged from when they were raised. Only the numeric id is kept, never a title or a person.
export function workItemAge(open, now) {
  const items = open
    .map((o) => ({ id: o.id, status: o.status, age: Math.max(0, Math.round(((now - o.created) / DAY) * 10) / 10) }))
    .sort((a, b) => b.age - a.age);
  const ages = sortedNums(items.map((i) => i.age));
  return { count: items.length, p50: r1(percentile(ages, 0.5)), items };
}

// Cumulative arrivals and departures per day. The gap between the lines is the net change in open work.
export function arrivalsDepartures(arrivals, resolved, now, windowDays = WEEKS * 7) {
  const today = startOfDayUTC(now);
  const start = today - (windowDays - 1) * DAY;
  const a = new Array(windowDays).fill(0), d = new Array(windowDays).fill(0);
  for (const c of arrivals) { const i = Math.floor((startOfDayUTC(c) - start) / DAY); if (i >= 0 && i < windowDays) a[i]++; }
  for (const r of resolved) { const i = Math.floor((startOfDayUTC(r.resolved) - start) / DAY); if (i >= 0 && i < windowDays) d[i]++; }
  let ca = 0, cd = 0;
  const days = a.map((_, i) => { ca += a[i]; cd += d[i]; return { day: iso(start + i * DAY), arrived: ca, departed: cd }; });
  return { windowDays, days, netChange: ca - cd };
}

// ---- Status history: cumulative flow and work in progress over time ----
// An item here is { created, resolved|null, current, changes: [{ t, from, to }] } with status changes oldest first.
// Only status names and timestamps are used; nothing about people is ever read or returned.
const DONE_NAME = /^(done|closed|resolved|released|complete|completed|declined|rejected|cancell?ed|won'?t)/i;
const DOING_NAME = /progress|review|develop|test|verif|implement|building|waiting for release|ready for/i;

// Maps a status name to 'todo', 'doing' or 'done'. The tracker's own categories win; names are only a fallback.
export function categoryOf(name, map) {
  if (map && map[name]) return map[name];
  if (!name) return 'todo';
  if (DONE_NAME.test(name)) return 'done';
  if (DOING_NAME.test(name)) return 'doing';
  return 'todo';
}

export function statusAt(item, t) {
  if (t < item.created) return null;
  let s = (item.changes.length && item.changes[0].from) || item.current;
  for (const c of item.changes) { if (c.t <= t) s = c.to; else break; }
  return s;
}
function stateAt(item, t, map) {
  if (item.resolved != null && t >= item.resolved) return 'done';
  const s = statusAt(item, t);
  return s == null ? null : categoryOf(s, map);
}

// Daily count of items raised in the window by where they stand that day. Stacked, the top edge is everything raised so far.
export function cumulativeFlow(items, now, map, windowDays = WEEKS * 7) {
  const today = startOfDayUTC(now), start = today - (windowDays - 1) * DAY;
  const cohort = items.filter((it) => it.created >= start && it.created <= now);
  const days = [];
  for (let i = 0; i < windowDays; i++) {
    const t = Math.min(start + (i + 1) * DAY - 1, now);
    let todo = 0, doing = 0, done = 0;
    for (const it of cohort) {
      if (it.created > t) continue;
      const st = stateAt(it, t, map);
      if (st === 'done') done++; else if (st === 'doing') doing++; else if (st === 'todo') todo++;
    }
    days.push({ day: iso(start + i * DAY), todo, doing, done });
  }
  return { windowDays, raised: cohort.length, days };
}

// Weekly snapshot of everything in progress: how many items, and how old they are (days since raised).
export function wipTrend(items, now, map, weeks = WEEKS) {
  const first = startOfWeekUTC(now) - (weeks - 1) * 7 * DAY;
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const partial = w === weeks - 1;
    const t = partial ? now : first + (w + 1) * 7 * DAY - 1;
    const ages = [];
    for (const it of items) if (it.created <= t && stateAt(it, t, map) === 'doing') ages.push((t - it.created) / DAY);
    const sorted = sortedNums(ages);
    out.push({ week: iso(first + w * 7 * DAY), partial, wip: ages.length, p50: sorted.length >= 5 ? r1(percentile(sorted, 0.5)) : null, p85: sorted.length >= 5 ? r1(percentile(sorted, 0.85)) : null });
  }
  return { weeks: out };
}

// Monte Carlo: resample recent weekly throughput with replacement.
function simulate(sample, rnd, horizonWeeks, runs) {
  const totals = [];
  for (let i = 0; i < runs; i++) { let t = 0; for (let w = 0; w < horizonWeeks; w++) t += sample[Math.floor(rnd() * sample.length)]; totals.push(t); }
  return totals.sort((a, b) => a - b);
}
const band = (totals) => ({ p5: r0(percentile(totals, 0.05)), p15: r0(percentile(totals, 0.15)), p50: r0(percentile(totals, 0.5)), p85: r0(percentile(totals, 0.85)), p95: r0(percentile(totals, 0.95)) });

// weeklyCounts: complete weeks, oldest first. weekLabels: ISO date for each origin (length = counts + 1; the last is the coming week).
export function forecast(weeklyCounts, weekLabels, now, { horizonWeeks = 4, runs = 5000, lookback = 12 } = {}) {
  const n = weeklyCounts.length;
  const sample = weeklyCounts.slice(-lookback);
  const target = Math.max(10, Math.round((avg(sample) * 3) / 10) * 10); // a backlog of roughly three weeks of work
  if (sample.length < 4 || sample.every((c) => c === 0)) return null;
  const seed = Math.floor(startOfWeekUTC(now) / DAY);
  const rnd = mulberry32(seed);
  const totals = simulate(sample, rnd, horizonWeeks, runs);
  const weeksToTarget = [];
  for (let i = 0; i < runs; i++) {
    let done = 0, w = 0;
    while (done < target && w < 520) { done += sample[Math.floor(rnd() * sample.length)]; w++; }
    weeksToTarget.push(w);
  }
  weeksToTarget.sort((a, b) => a - b);

  // How the forecast has moved: for each earlier week, what would we have forecast for the next four weeks, and what happened?
  const history = [];
  for (let o = lookback; o <= n; o++) {
    const s = weeklyCounts.slice(o - lookback, o);
    const b = band(simulate(s, mulberry32(seed + o), horizonWeeks, 1000));
    const actual = o + horizonWeeks <= n ? weeklyCounts.slice(o, o + horizonWeeks).reduce((x, y) => x + y, 0) : null;
    history.push({ week: weekLabels[o], ...b, actual });
  }
  const judged = history.filter((h) => h.actual != null);
  return {
    basedOnWeeks: sample.length,
    runs,
    horizonWeeks,
    outcomes: { atLeast50: r0(percentile(totals, 0.5)), atLeast85: r0(percentile(totals, 0.15)), atLeast95: r0(percentile(totals, 0.05)) },
    target,
    weeksToTarget: { p50: r0(percentile(weeksToTarget, 0.5)), p85: r0(percentile(weeksToTarget, 0.85)), p95: r0(percentile(weeksToTarget, 0.95)) },
    history,
    calibration: { judged: judged.length, atLeast85Held: judged.filter((h) => h.actual >= h.p15).length },
  };
}

const dirOf = (change, tol = 5) => (change == null ? 'unknown' : change > tol ? 'rose' : change < -tol ? 'fell' : 'broadly flat');
const lowerIsBetter = (change, tol = 5) => (change == null ? 'unknown' : change < -tol ? 'improved' : change > tol ? 'worsened' : 'broadly flat');

// The numbers the commentary may draw on. Nothing here identifies a person.
export function insightFacts(report, now) {
  const full = report.throughput.weeks.filter((w) => !w.partial).map((w) => w.count);
  const last4 = avg(full.slice(-4)), prior8 = avg(full.slice(-12, -4));
  const tpChange = pct(last4, prior8);
  const lastWeek = full[full.length - 1];
  const ptsIn = (fromDays, toDays) => report.leadTime.points.filter((p) => { const age = (now - p[0] * 60000) / DAY; return age >= fromDays && age < toDays; }).map((p) => p[1]);
  const recent = sortedNums(ptsIn(0, 28)), prior = sortedNums(ptsIn(28, 84));
  const ltR50 = r1(percentile(recent, 0.5)), ltP50 = r1(percentile(prior, 0.5));
  const ltR85 = r1(percentile(recent, 0.85)), ltP85 = r1(percentile(prior, 0.85));
  const ages = report.age.items;
  const over85 = ages.filter((i) => report.leadTime.p85 != null && i.age > report.leadTime.p85);
  const statuses = {};
  for (const i of ages) { const s = (statuses[i.status] = statuses[i.status] || { items: 0, oldestDays: 0 }); s.items++; s.oldestDays = Math.max(s.oldestDays, Math.round(i.age)); }
  const days = report.flow.days, L = days.length;
  const at = (k) => days[Math.max(0, L - 1 - k)];
  const arr30 = at(0).arrived - at(30).arrived, dep30 = at(0).departed - at(30).departed;
  const f = report.forecast;
  const wipFacts = (() => {
    if (!report.wip) return null;
    const w = report.wip.weeks, nowP = w[w.length - 1], then = w[Math.max(0, w.length - 5)];
    const wipChange = pct(nowP.wip, then.wip), ageChange = pct(nowP.p50, then.p50);
    return {
      itemsNow: nowP.wip, itemsFourWeeksAgo: then.wip, changeVsFourWeeksAgoPercent: wipChange, direction: dirOf(wipChange),
      medianAgeNowDays: nowP.p50, medianAgeFourWeeksAgoDays: then.p50, ageChangePercent: ageChange, ageDirection: lowerIsBetter(ageChange),
      peakItems: Math.max(...w.map((x) => x.wip)), lowestItems: Math.min(...w.map((x) => x.wip)),
    };
  })();
  const cfdFacts = (() => {
    if (!report.cfd) return null;
    const d = report.cfd.days, last = d[d.length - 1], ago = d[Math.max(0, d.length - 29)];
    const total = last.todo + last.doing + last.done;
    return {
      itemsRaisedInWindow: report.cfd.raised, notStartedNow: last.todo, inProgressNow: last.doing, doneNow: last.done,
      doneSharePercent: total ? r0((last.done / total) * 100) : 0,
      inProgressFourWeeksAgo: ago.doing, inProgressChangePercent: pct(last.doing, ago.doing), inProgressDirection: dirOf(pct(last.doing, ago.doing)),
      notStartedFourWeeksAgo: ago.todo,
    };
  })();
  return {
    period: { weeks: WEEKS, from: report.throughput.weeks[0].week, to: report.generatedAt.slice(0, 10) },
    throughput: {
      weeklyAverage26: report.throughput.average,
      last4WeeksAverage: r1(last4), previous8WeeksAverage: r1(prior8),
      changeVsPreviousPercent: tpChange, direction: dirOf(tpChange),
      lastCompleteWeek: lastWeek, bestWeek: Math.max(...full), lowestWeek: Math.min(...full),
      trendChangePerWeek: report.throughput.trend.slope,
    },
    leadTimeDays: {
      median26Weeks: report.leadTime.p50, p85Of26Weeks: report.leadTime.p85, p95Of26Weeks: report.leadTime.p95,
      medianLast4Weeks: ltR50, medianPrevious8Weeks: ltP50, medianChangePercent: pct(ltR50, ltP50), medianDirection: lowerIsBetter(pct(ltR50, ltP50)),
      p85Last4Weeks: ltR85, p85Previous8Weeks: ltP85, p85ChangePercent: pct(ltR85, ltP85), p85Direction: lowerIsBetter(pct(ltR85, ltP85)),
    },
    workInProgress: {
      itemsInProgress: report.age.count, medianAgeDays: report.age.p50,
      itemsOlderThanP85LeadTime: over85.length, shareOlderPercent: report.age.count ? r0((over85.length / report.age.count) * 100) : 0,
      oldestDays: ages.length ? r0(ages[0].age) : null, byStatus: statuses,
      ...(wipFacts ? { overTime: wipFacts } : {}),
    },
    flow: {
      raisedLast26Weeks: at(0).arrived, resolvedLast26Weeks: at(0).departed, netChange26Weeks: report.flow.netChange,
      raisedLast30Days: arr30, resolvedLast30Days: dep30, netChangeLast30Days: arr30 - dep30,
      last30DaysDirection: arr30 > dep30 ? 'open work grew' : arr30 < dep30 ? 'open work shrank' : 'open work was unchanged',
    },
    ...(cfdFacts ? { cumulativeFlow: cfdFacts } : {}),
    forecastNext4Weeks: f && {
      resolvedAtLeast50Percent: f.outcomes.atLeast50, resolvedAtLeast85Percent: f.outcomes.atLeast85, resolvedAtLeast95Percent: f.outcomes.atLeast95,
      actualLast4Weeks: full.slice(-4).reduce((a, b) => a + b, 0),
      backlogToClearItems: f.target, weeksToClearAt50Percent: f.weeksToTarget.p50, weeksToClearAt85Percent: f.weeksToTarget.p85,
      pastForecastsJudged: f.calibration.judged, pastForecastsWhereActualMetAtLeast85Level: f.calibration.atLeast85Held,
    },
  };
}

export function buildReport({ resolved, arrivals, open, totals, history }, now) {
  const tp = throughput(resolved, now);
  const labels = tp.weeks.map((w) => w.week);
  const report = {
    generatedAt: new Date(now).toISOString(),
    totals,
    throughput: tp,
    leadTime: leadTime(resolved, now),
    age: workItemAge(open, now),
    flow: arrivalsDepartures(arrivals, resolved, now),
    forecast: forecast(tp.weeks.filter((w) => !w.partial).map((w) => w.count), labels, now),
    cfd: null,
    wip: null,
  };
  // Status history is optional: without enough of it the page falls back to the snapshot views.
  if (history && history.items && history.items.length >= 20) {
    report.cfd = cumulativeFlow(history.items, now, history.categories);
    report.wip = wipTrend(history.items, now, history.categories);
    if (!report.cfd.raised) report.cfd = null;
  }
  report.facts = insightFacts(report, now);
  return report;
}
