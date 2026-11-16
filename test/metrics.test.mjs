import assert from 'node:assert/strict';
import { buildReport, percentile, startOfWeekUTC, cumulativeFlow, wipTrend, statusAt, categoryOf } from '../src/metrics.js';
const DAY = 86400000, now = Date.UTC(2026, 10, 4, 12);
let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
const resolved = [], arrivals = [], open = [];
for (let i = 0; i < 1000; i++) { const r = now - rnd() * 190 * DAY; resolved.push({ resolved: r, created: r - Math.exp(rnd() * 7) * DAY }); }
for (let i = 0; i < 700; i++) arrivals.push(now - rnd() * 190 * DAY);
for (let i = 0; i < 40; i++) open.push({ id: 90000 + i, status: ['In Progress', 'In Review', 'Waiting for Release'][i % 3], created: now - rnd() * 400 * DAY });
const t0 = Date.now();
const rep = buildReport({ resolved, arrivals, open, totals: { open: 7831, resolvedLast365: 1921 } }, now);
console.log('compute ms', Date.now() - t0, 'json kB', Math.round(JSON.stringify(rep).length / 1024));
assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
assert.equal(new Date(startOfWeekUTC(now)).getUTCDay(), 1);
assert.equal(rep.throughput.weeks.length, 27);
assert.equal(rep.throughput.weeks.at(-1).partial, true);
assert.equal(rep.leadTime.weekly.length, 26);
assert.ok(rep.leadTime.p50 < rep.leadTime.p85 && rep.leadTime.p85 < rep.leadTime.p95);
assert.equal(rep.flow.days.length, 182);
assert.ok(rep.age.items[0].age >= rep.age.items.at(-1).age);
const f = rep.forecast;
assert.ok(f.outcomes.atLeast95 <= f.outcomes.atLeast85 && f.outcomes.atLeast85 <= f.outcomes.atLeast50);
assert.ok(f.weeksToTarget.p50 <= f.weeksToTarget.p95);
assert.equal(f.history.at(-1).actual, null);                 // the coming weeks have not happened yet
assert.equal(f.history.at(-1).week, rep.throughput.weeks.at(-1).week);
assert.ok(f.history.filter((h) => h.actual != null).length === f.calibration.judged);
assert.ok(f.calibration.atLeast85Held <= f.calibration.judged);
assert.ok(['rose', 'fell', 'broadly flat'].includes(rep.facts.throughput.direction));
assert.ok(rep.facts.workInProgress.itemsInProgress === 40);
assert.ok(!JSON.stringify(rep).match(/assignee|reporter|displayName|JRACLOUD|atlassian|jira/i), 'no people or source names in the payload');

// ---- status history ----
const A = now - 10 * DAY;
const item = { created: A, resolved: A + 6 * DAY, current: 'Closed', changes: [{ t: A + 2 * DAY, from: 'Open', to: 'In Progress' }, { t: A + 5 * DAY, from: 'In Progress', to: 'In Review' }, { t: A + 6 * DAY, from: 'In Review', to: 'Closed' }] };
assert.equal(statusAt(item, A - 1), null, 'not raised yet');
assert.equal(statusAt(item, A + 1 * DAY), 'Open');
assert.equal(statusAt(item, A + 3 * DAY), 'In Progress');
assert.equal(statusAt(item, A + 5.5 * DAY), 'In Review');
assert.equal(statusAt({ created: A, resolved: null, current: 'Open', changes: [] }, now), 'Open', 'no changes: current status');
assert.equal(categoryOf('In Review'), 'doing'); assert.equal(categoryOf('Open'), 'todo'); assert.equal(categoryOf('Closed'), 'done');
assert.equal(categoryOf('Backlog', { Backlog: 'doing' }), 'doing', "the tracker's grouping wins over names");
const cf = cumulativeFlow([item], now, null, 14);
assert.equal(cf.days.length, 14); assert.equal(cf.raised, 1);
const byDay = Object.fromEntries(cf.days.map((d) => [d.day, d]));
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
assert.deepEqual([byDay[dayOf(A)].todo, byDay[dayOf(A)].doing, byDay[dayOf(A)].done], [1, 0, 0]);
assert.deepEqual([byDay[dayOf(A + 3 * DAY)].todo, byDay[dayOf(A + 3 * DAY)].doing, byDay[dayOf(A + 3 * DAY)].done], [0, 1, 0]);
assert.deepEqual([byDay[dayOf(now)].todo, byDay[dayOf(now)].doing, byDay[dayOf(now)].done], [0, 0, 1]);
assert.ok(cf.days.every((d) => d.todo + d.doing + d.done <= cf.raised), 'bands never exceed what was raised');
const many = Array.from({ length: 30 }, (_, i) => ({ created: now - (100 + i) * DAY, resolved: null, current: 'In Progress', changes: [] }));
const wt = wipTrend(many, now, null, 26);
assert.equal(wt.weeks.length, 26); assert.equal(wt.weeks.at(-1).wip, 30); assert.ok(wt.weeks.at(-1).p50 > 100);
assert.equal(wipTrend([item], now, null, 26).weeks.at(-1).p50, null, 'no ages from fewer than five items');
const repH = buildReport({ resolved, arrivals, open, totals: { open: 7831, resolvedLast365: 1921 }, history: { items: many.concat(Array.from({ length: 30 }, (_, i) => ({ created: now - (i + 1) * 5 * DAY, resolved: null, current: 'Open', changes: [] }))), categories: null } }, now);
assert.ok(repH.cfd && repH.wip && repH.facts.cumulativeFlow && repH.facts.workInProgress.overTime);
assert.equal(repH.facts.cumulativeFlow.inProgressNow, 30); assert.equal(repH.facts.cumulativeFlow.notStartedNow, 30);
assert.equal(rep.cfd, null, 'no history: no cfd'); assert.equal(rep.wip, null); assert.equal(rep.facts.cumulativeFlow, undefined);
assert.ok(!JSON.stringify(repH).match(/assignee|reporter|displayName/i));
console.log(JSON.stringify(rep.facts));
console.log('ok');

// ---- second-layer signals ----
{
  const { insightSignals } = await import('../src/signals.js');
  const D = 86400000, n0 = Date.UTC(2026, 10, 4, 12);
  const wk = (counts) => ({ weeks: counts.map((c, i) => ({ week: 'w' + i, count: c, partial: false })).concat([{ week: 'now', count: 3, partial: true }]) });
  const base = (counts, extra = {}) => ({
    throughput: wk(counts), leadTime: { p50: 10, p85: 30, p95: 120, points: Array.from({ length: 60 }, (_, i) => [i, i % 2 ? 3 : 150]) },
    age: { count: 12, items: Array.from({ length: 12 }, (_, i) => ({ id: i, status: i < 9 ? 'Waiting for review' : 'In Progress', age: 100 - i * 5 })) },
    flow: { days: Array.from({ length: 182 }, (_, i) => ({ arrived: i * 3, departed: i * 2 })), netChange: 181 }, cfd: null,
    forecast: { outcomes: { atLeast50: 80, atLeast85: 60, atLeast95: 50 }, calibration: { judged: 10, atLeast85Held: 6 } }, ...extra });
  const lumpy = insightSignals(base([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 60, 70, 80, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]));
  assert.equal(lumpy.throughput.id, 'lumpy-output');
  assert.equal(insightSignals(base(Array(26).fill(30))).throughput.id, 'steady-output');
  assert.equal(lumpy.leadTime.id, 'two-populations');
  assert.equal(lumpy.workInProgress.id, 'stuck-in-status'); // 9 of 12 wait in review; the plain working status is ignored
  assert.equal(lumpy.forecast.id, 'overconfident');
  assert.ok(lumpy.flow.insight.includes('1.5')); // 3 arrive for 2 resolved
  assert.ok(lumpy.overall && lumpy.nextActions.length === 2);
  // too little data: no signal rather than a made-up one
  assert.equal(insightSignals(base([5, 5, 5])).throughput, undefined);
}
console.log('signals ok');
