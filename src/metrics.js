// Pure flow-metric calculations. No network and no Worker APIs, so they can be tested with plain Node.
// Inputs are plain objects; nothing about people (assignees, reporters) is ever read or returned.

const DAY = 86400000;

export function startOfWeekUTC(ms) {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}
const startOfDayUTC = (ms) => ms - (((ms % DAY) + DAY) % DAY);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// Linear-interpolated percentile of an ascending array, p in 0..1.
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// Small seeded PRNG so a cached forecast does not change on every refresh.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function throughput(resolved, now, weeks = 26) {
  const thisWeek = startOfWeekUTC(now);
  const first = thisWeek - weeks * 7 * DAY;
  const buckets = [];
  for (let i = 0; i <= weeks; i++) buckets.push({ start: first + i * 7 * DAY, count: 0 });
  for (const r of resolved) {
    const i = Math.floor((startOfWeekUTC(r.resolved) - first) / (7 * DAY));
    if (i >= 0 && i < buckets.length) buckets[i].count++;
  }
  const out = buckets.map((b, i) => ({ week: iso(b.start), count: b.count, partial: i === buckets.length - 1 }));
  // Trend over complete weeks only (the current week is still filling up).
  const full = out.filter((w) => !w.partial);
  const n = full.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  full.forEach((w, x) => { sx += x; sy += w.count; sxy += x * w.count; sxx += x * x; });
  const slope = n > 1 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
  const intercept = n ? (sy - slope * sx) / n : 0;
  const counts = full.map((w) => w.count).sort((a, b) => a - b);
  return {
    weeks: out,
    trend: { slope: Math.round(slope * 100) / 100, intercept: Math.round(intercept * 100) / 100 },
    median: percentile(counts, 0.5),
    average: n ? Math.round((sy / n) * 10) / 10 : 0,
  };
}

export function leadTime(resolved, now, windowDays = 90) {
  const from = now - windowDays * DAY;
  const pts = resolved
    .filter((r) => r.resolved >= from && r.resolved <= now && r.resolved >= r.created)
    .map((r) => ({ t: r.resolved, d: (r.resolved - r.created) / DAY }));
  const sorted = pts.map((p) => p.d).sort((a, b) => a - b);
  return {
    windowDays,
    n: pts.length,
    p50: r1(percentile(sorted, 0.5)),
    p85: r1(percentile(sorted, 0.85)),
    p95: r1(percentile(sorted, 0.95)),
    points: pts.map((p) => [Math.round(p.t / 60000), Math.round(p.d * 100) / 100]), // [epoch minutes, days]
  };
}

export function workItemAge(open, now) {
  const items = open
    .map((o) => ({ key: o.key, status: o.status, age: Math.max(0, Math.round(((now - o.created) / DAY) * 10) / 10) }))
    .sort((a, b) => b.age - a.age);
  const ages = items.map((i) => i.age).sort((a, b) => a - b);
  return { count: items.length, p50: r1(percentile(ages, 0.5)), items };
}

// Cumulative arrivals and departures per day. The gap between the lines is the net change in open work.
export function arrivalsDepartures(arrivals, resolved, now, windowDays = 90) {
  const today = startOfDayUTC(now);
  const start = today - (windowDays - 1) * DAY;
  const a = new Array(windowDays).fill(0), d = new Array(windowDays).fill(0);
  for (const c of arrivals) { const i = Math.floor((startOfDayUTC(c) - start) / DAY); if (i >= 0 && i < windowDays) a[i]++; }
  for (const r of resolved) { const i = Math.floor((startOfDayUTC(r.resolved) - start) / DAY); if (i >= 0 && i < windowDays) d[i]++; }
  let ca = 0, cd = 0;
  const days = a.map((_, i) => { ca += a[i]; cd += d[i]; return { day: iso(start + i * DAY), arrived: ca, departed: cd }; });
  return { windowDays, days, netChange: ca - cd };
}

// Monte Carlo from recent weekly throughput (resampling with replacement).
export function forecast(weeklyCounts, now, { horizonWeeks = 4, target = 25, runs = 5000 } = {}) {
  const sample = weeklyCounts.slice(-12);
  if (sample.length < 4 || sample.every((c) => c === 0)) return null;
  const rnd = mulberry32(Math.floor(startOfWeekUTC(now) / DAY));
  const pick = () => sample[Math.floor(rnd() * sample.length)];
  const totals = [], weeksToTarget = [];
  for (let i = 0; i < runs; i++) {
    let t = 0; for (let w = 0; w < horizonWeeks; w++) t += pick();
    totals.push(t);
    let done = 0, w = 0;
    while (done < target && w < 520) { done += pick(); w++; }
    weeksToTarget.push(w);
  }
  totals.sort((a, b) => a - b); weeksToTarget.sort((a, b) => a - b);
  // "85% confident of at least X" means the 15th percentile of outcomes.
  const hist = new Map();
  const bin = Math.max(1, Math.round((totals[totals.length - 1] - totals[0]) / 24));
  for (const t of totals) { const b = Math.floor(t / bin) * bin; hist.set(b, (hist.get(b) || 0) + 1); }
  return {
    basedOnWeeks: sample.length,
    runs,
    horizonWeeks,
    outcomes: { atLeast50: Math.round(percentile(totals, 0.5)), atLeast85: Math.round(percentile(totals, 0.15)), atLeast95: Math.round(percentile(totals, 0.05)) },
    histogram: { bin, bars: [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([x, n]) => [x, n]) },
    target,
    weeksToTarget: { p50: Math.round(percentile(weeksToTarget, 0.5)), p85: Math.round(percentile(weeksToTarget, 0.85)), p95: Math.round(percentile(weeksToTarget, 0.95)) },
  };
}

export function buildReport({ resolved, arrivals, open, totals }, now) {
  const tp = throughput(resolved, now);
  return {
    generatedAt: new Date(now).toISOString(),
    source: 'jira.atlassian.com, project JRACLOUD (public)',
    totals,
    throughput: tp,
    leadTime: leadTime(resolved, now),
    age: workItemAge(open, now),
    flow: arrivalsDepartures(arrivals, resolved, now),
    forecast: forecast(tp.weeks.filter((w) => !w.partial).map((w) => w.count), now),
  };
}
