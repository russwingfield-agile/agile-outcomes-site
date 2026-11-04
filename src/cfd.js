// Cumulative flow of the items raised in the last 26 weeks: where each one stands on each date.
// Bands are exhaustive (untriaged, backlog, active, done), so they stack to the number raised so far.
// Each cell is one Jira count query. Past dates never change, so cells are cached and filled a few at a time.
import { count, PROJECT, jqlList } from './jira.js';

const DAY = 86400000;
export const BANDS = ['untriaged', 'backlog', 'active', 'done'];
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// Fortnightly Mondays from 26 weeks ago to this week's Monday. The first date has no items by definition.
export function planDates(now, weeks = 26, stepDays = 14) {
  const d = new Date(now);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const start = monday - weeks * 7 * DAY;
  const dates = [];
  for (let t = start; t <= monday; t += stepDays * DAY) dates.push(iso(t));
  return { start: iso(start), dates };
}

export const cellKey = (date, band) => date + '|' + band;

export function cellJql(band, names, start, date) {
  const base = 'project = ' + PROJECT + ' AND created >= "' + start + '"';
  if (!names.length) return null;
  return date === 'now'
    ? base + ' AND status IN (' + jqlList(names) + ')'
    : base + ' AND created < "' + date + '" AND status WAS IN (' + jqlList(names) + ') ON "' + date + '"';
}

// Cells still to fetch, oldest first. Past cells are fetched once; the "now" cells are cleared by the caller when stale.
export function missingCells(plan, cells) {
  const out = [];
  for (const date of [...plan.dates.slice(1), 'now']) for (const b of BANDS) if (cells[cellKey(date, b)] == null) out.push({ date, band: b });
  return out;
}

export function assemble(plan, cells, nowDate) {
  const pts = [{ date: plan.dates[0], untriaged: 0, backlog: 0, active: 0, done: 0 }];
  for (const date of plan.dates.slice(1)) pts.push({ date, ...Object.fromEntries(BANDS.map((b) => [b, cells[cellKey(date, b)] || 0])) });
  pts.push({ date: nowDate, now: true, ...Object.fromEntries(BANDS.map((b) => [b, cells[cellKey('now', b)] || 0])) });
  return pts.map((p) => ({ ...p, total: BANDS.reduce((s, b) => s + p[b], 0) }));
}

// Run a batch of count queries, six at a time (the Workers limit on simultaneous connections).
export async function fillCells(todo, groups, start, cells, limit = 36) {
  const batch = todo.slice(0, limit);
  for (let i = 0; i < batch.length; i += 6) {
    await Promise.all(batch.slice(i, i + 6).map(async (c) => {
      const jql = cellJql(c.band, groups[c.band], start, c.date);
      if (jql == null) { cells[cellKey(c.date, c.band)] = 0; return; }
      try { cells[cellKey(c.date, c.band)] = await count(jql); } catch (e) { /* leave it missing; the next call retries */ }
    }));
  }
  return batch.length;
}

// Plain-language figures about the latest point, for the commentary. Nothing here identifies a person.
export function cfdFacts(points) {
  const now = points[points.length - 1];
  if (!now || !now.total) return null;
  const pc = (n) => Math.round((n / now.total) * 100);
  const early = points[Math.max(1, Math.floor((points.length - 1) / 2))];
  return {
    raisedInPeriod: now.total,
    stillUntriagedPercent: pc(now.untriaged), inBacklogPercent: pc(now.backlog), beingWorkedPercent: pc(now.active), closedPercent: pc(now.done),
    closedPercentAtMidPeriod: early && early.total ? Math.round((early.done / early.total) * 100) : null,
  };
}
