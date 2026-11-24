// Reads a tracker export (Jira, Linear, Azure DevOps and similar) into the inputs the dashboard maths needs.
// Pure functions, no DOM and no network: the file is read in the visitor's browser and never uploaded.
// Only keys, status names and dates are read. Titles, descriptions and people columns are never looked at.

import { buildReport, categoryOf } from './metrics.js';

const DAY = 86400000;
export const MAX_BYTES = 20 * 1024 * 1024;
export const MIN_RESOLVED = 15;     // finished items in the window needed before the charts mean anything
export const START_COVERAGE = 0.7;  // share of finished or in-progress items that need a start date before status history is drawn

/* ---------- CSV text to rows (RFC 4180: quotes, doubled quotes, line breaks inside quoted cells) ---------- */
function detectDelimiter(text) {
  let inQ = false, c = { ',': 0, ';': 0, '\t': 0 };
  for (let i = 0; i < text.length && i < 4000; i++) {
    const ch = text[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === '\n') break;
    else if (!inQ && ch in c) c[ch]++;
  }
  return c[';'] > c[','] && c[';'] >= c['\t'] ? ';' : c['\t'] > c[','] ? '\t' : ',';
}

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = detectDelimiter(text);
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch;
    } else if (ch === '"' && cell === '') inQ = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/* ---------- finding the columns ---------- */
// Each field lists the header names it may appear under, best first. The first column that matches is used (exports often repeat names such as Labels).
const ALIASES = {
  key: ['issue key', 'key', 'identifier', 'id', 'work item id', 'issue id', 'ticket', 'number'],
  created: ['created', 'created date', 'created at', 'date created', 'created on', 'system.createddate', 'raised'],
  resolved: ['resolved', 'resolution date', 'resolutiondate', 'resolved date', 'completed', 'completed at', 'closed date', 'closed', 'date closed', 'closed at', 'done date', 'finished', 'microsoft.vsts.common.closeddate', 'microsoft.vsts.common.resolveddate'],
  started: ['started', 'started at', 'start date', 'activated date', 'date started', 'in progress date', 'first in progress', 'microsoft.vsts.common.activateddate'],
  updated: ['updated', 'updated at', 'last updated', 'date updated', 'changed date', 'modified', 'system.changeddate'],
  status: ['status', 'state', 'current status', 'workflow state', 'system.state'],
  category: ['status category'],
  categoryChanged: ['status category changed'],
  resolution: ['resolution'],
  canceled: ['canceled', 'cancelled', 'canceled at', 'cancelled at', 'canceled date'],
};
export const FIELD_LABELS = {
  key: 'Item id', created: 'Created', resolved: 'Finished', started: 'Started', updated: 'Last updated', status: 'Status',
  category: 'Status category', categoryChanged: 'Status category changed', resolution: 'Resolution', canceled: 'Cancelled',
};
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export function detectColumns(header) {
  const names = header.map(norm);
  const out = {};
  for (const [field, list] of Object.entries(ALIASES)) {
    out[field] = -1;
    for (const a of list) { const i = names.indexOf(a); if (i >= 0) { out[field] = i; break; } }
  }
  return out;
}

/* ---------- dates ---------- */
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const mon = (s) => MON[String(s).slice(0, 3).toLowerCase()];
const year = (y) => { y = Number(y); return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y; };
function clock(h, m, s, ap) {
  h = Number(h || 0);
  if (ap) { ap = ap.toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
  return [h, Number(m || 0), Number(s || 0)];
}
const T = '(?:[ T,]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*([AaPp][Mm])?)?';
const RE = {
  iso: /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/,
  jira: new RegExp('^(\\d{1,2})[/ -]([A-Za-z]{3,9})[/ ,-]+(\\d{2,4})' + T + '$'),         // 13/Mar/26 9:41 AM, 13 March 2026
  mdy: new RegExp('^([A-Za-z]{3,9})\\.? (\\d{1,2}),? (\\d{4})' + T + '$'),                 // Mar 13, 2026 9:41 AM
  num: new RegExp('^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{2,4})' + T + '$'),                  // 13/03/2026 09:41, 03/13/2026
};

// Works out, from the whole column, whether numeric dates are day-first or month-first.
function numericOrder(values) {
  let dayFirst = 0, monthFirst = 0;
  for (const v of values) {
    const m = RE.num.exec(v); if (!m) continue;
    if (Number(m[1]) > 12) dayFirst++; else if (Number(m[2]) > 12) monthFirst++;
  }
  return dayFirst === 0 && monthFirst === 0 ? { order: 'dmy', sure: false } : { order: monthFirst > dayFirst ? 'mdy' : 'dmy', sure: true };
}

export function makeDateParser(order = 'dmy') {
  return function parse(v) {
    v = String(v == null ? '' : v).trim();
    if (!v) return null;
    let m, t;
    if ((m = RE.iso.exec(v))) {
      t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      if (m[7] && m[7] !== 'Z') { const sign = m[7][0] === '-' ? -1 : 1, hh = +m[7].slice(1, 3), mm = +m[7].slice(-2); t -= sign * (hh * 60 + mm) * 60000; }
    } else if ((m = RE.jira.exec(v)) && mon(m[2]) != null) {
      const [h, mi, s] = clock(m[4], m[5], m[6], m[7]); t = Date.UTC(year(m[3]), mon(m[2]), +m[1], h, mi, s);
    } else if ((m = RE.mdy.exec(v)) && mon(m[1]) != null) {
      const [h, mi, s] = clock(m[4], m[5], m[6], m[7]); t = Date.UTC(+m[3], mon(m[1]), +m[2], h, mi, s);
    } else if ((m = RE.num.exec(v))) {
      const [h, mi, s] = clock(m[4], m[5], m[6], m[7]);
      const a = +m[1], b = +m[2];
      t = order === 'mdy' ? Date.UTC(year(m[3]), a - 1, b, h, mi, s) : Date.UTC(year(m[3]), b - 1, a, h, mi, s);
    } else {
      t = Date.parse(v); // formats such as "Tue Oct 10 2023 09:34:05 GMT+0000 (UTC)"
    }
    if (!isFinite(t)) return null;
    const y = new Date(t).getUTCFullYear();
    return y >= 2000 && y <= 2100 ? t : null;
  };
}

/* ---------- statuses ---------- */
export const KINDS = { todo: 'Not started', doing: 'In progress', done: 'Done', skip: 'Left out' };
const TODO_NAME = /^(to ?do|open|new|backlog|reopened|triage|icebox|planned|proposed|unstarted|selected for dev|ready for (dev|work|sprint|planning)|ready to (start|work)|not started|on hold|parked)/i;
const SKIP_NAME = /^(cancell?ed|duplicate|won'?t|declined|rejected|obsolete|invalid|abandoned|not a bug|cannot reproduce)/i;
const SKIP_RESOLUTION = /won'?t|duplicate|declin|reject|invalid|cannot reproduce|not a bug|obsolete|incomplete|abandon|cancel|unresolved/i;
export function guessKind(status) {
  if (SKIP_NAME.test(status || '')) return 'skip';
  if (TODO_NAME.test(status || '')) return 'todo';
  return categoryOf(status, null);
}
function kindFromCategory(c) {
  c = norm(c);
  return /^(done|complete|completed|closed|resolved)/.test(c) ? 'done' : /progress|indeterminate|active|started/.test(c) ? 'doing' : /^(to ?do|new|open|backlog|proposed|unstarted)/.test(c) ? 'todo' : null;
}

/* ---------- table to items ---------- */
// mapping: column index per field (-1 when absent). kinds: the visitor's own choice of kind per status name, if any.
// Returns the items (times in ms), the statuses found with the kind used for each, and plain-English notes on what was assumed.
export function readItems(rows, mapping, kinds = {}, { now = Date.now() } = {}) {
  const body = rows.slice(1);
  const notes = [];
  const cell = (r, f) => (mapping[f] >= 0 && mapping[f] < r.length ? r[mapping[f]] : '');
  const dateCols = ['created', 'resolved', 'started', 'updated', 'categoryChanged', 'canceled'].filter((f) => mapping[f] >= 0);
  // One date order for the whole file, decided from every date column together.
  const numeric = []; for (const f of dateCols) for (const r of body) numeric.push(String(cell(r, f)).trim());
  const ord = numericOrder(numeric);
  const parse = makeDateParser(ord.order);
  const sawNumeric = numeric.some((v) => RE.num.test(v));
  const dateNote = sawNumeric ? (ord.sure ? (ord.order === 'dmy' ? 'Dates read as day first (13/03/2026 is 13 March).' : 'Dates read as month first (03/13/2026 is 13 March).') : 'Dates such as 03/04/2026 are ambiguous in your file; they were read as day first (3 April). If that is wrong, the charts will look odd.') : null;
  if (dateNote) notes.push(dateNote);

  // How each status is grouped: the visitor's choice, else the file's own status category, else a guess from the name.
  const byStatus = {};
  for (const r of body) {
    const s = String(cell(r, 'status')).trim(); if (!s) continue;
    const e = (byStatus[s] = byStatus[s] || { name: s, count: 0, cats: {} });
    e.count++;
    const k = kindFromCategory(cell(r, 'category')); if (k) e.cats[k] = (e.cats[k] || 0) + 1;
  }
  const statuses = Object.values(byStatus).map((e) => {
    const fromFile = Object.entries(e.cats).sort((a, b) => b[1] - a[1])[0];
    const guess = SKIP_NAME.test(e.name) ? 'skip' : fromFile ? fromFile[0] : guessKind(e.name);
    return { name: e.name, count: e.count, kind: kinds[e.name] || guess, guessed: !kinds[e.name], fromFile: !!fromFile };
  }).sort((a, b) => b.count - a.count);
  const kindOf = Object.fromEntries(statuses.map((s) => [s.name, s.kind]));

  const items = [];
  let skipped = 0, dropped = 0, usedUpdated = 0, noKey = 0;
  body.forEach((r, n) => {
    const created = parse(cell(r, 'created'));
    if (created == null || created > now + DAY) { skipped++; return; }
    const status = String(cell(r, 'status')).trim();
    const kind = status ? kindOf[status] : null;
    const resolution = String(cell(r, 'resolution')).trim();
    const canceled = parse(cell(r, 'canceled'));
    // Items closed without being delivered (won't do, duplicate, cancelled) were raised, but they are not finished work.
    const notDelivered = kind === 'skip' || canceled != null || (resolution && SKIP_RESOLUTION.test(resolution) && !/^done$|^fixed$|^resolved$/i.test(resolution));
    let key = String(cell(r, 'key')).trim();
    if (!key) { noKey++; key = '#' + (n + 2); }
    const it = { id: key, created, resolved: null, started: null, updated: null, status, kind, drop: false };
    it.updated = parse(cell(r, 'updated'));
    it.started = parse(cell(r, 'started'));
    const catChanged = parse(cell(r, 'categoryChanged'));
    let resolved = parse(cell(r, 'resolved'));
    if (notDelivered) { it.drop = true; dropped++; items.push(it); return; }
    if (resolved == null && kind === 'done') { // finished, but the file does not say when: the closest date it does have
      resolved = catChanged != null ? catChanged : it.updated;
      if (resolved != null) usedUpdated++;
    }
    if (resolved != null && resolved < created) resolved = created;
    it.resolved = resolved;
    // Jira: the date the status category last changed is when an item still in progress entered progress.
    if (it.started == null && kind === 'doing' && catChanged != null && catChanged >= created) it.started = catChanged;
    items.push(it);
  });
  if (skipped) notes.push(`${skipped} ${skipped === 1 ? 'row was' : 'rows were'} left out because the created date could not be read.`);
  if (dropped) notes.push(`${dropped} ${dropped === 1 ? 'item was' : 'items were'} closed without being delivered (won't do, duplicate, cancelled) and ${dropped === 1 ? 'is' : 'are'} not counted as finished work.`);
  if (usedUpdated) notes.push(`${usedUpdated} done ${usedUpdated === 1 ? 'item has' : 'items have'} no finished date, so ${mapping.categoryChanged >= 0 ? 'the status category changed date' : 'the last updated date'} was used.`);
  if (noKey) notes.push('No item id column was found, so rows are numbered instead.');
  return { items, statuses, notes };
}

/* ---------- items to dashboard ---------- */
const latest = (items) => items.reduce((m, i) => Math.max(m, i.created, i.resolved || 0, i.updated || 0, i.started || 0), 0);

export function buildYourReport(rows, overrides = {}, { now = Date.now() } = {}) {
  if (!rows || rows.length < 2) return { error: 'The file has a header row but no items in it.' };
  const mapping = { ...detectColumns(rows[0]), ...(overrides.mapping || {}) };
  const names = rows[0];
  if (mapping.created < 0) return { error: 'No created date column was found. The columns in your file are: ' + names.filter(Boolean).slice(0, 14).join(', ') + (names.length > 14 ? ', …' : '') + '. Pick the right one under "How the file was read".', mapping, rows, columns: names };
  if (mapping.resolved < 0 && mapping.status < 0) return { error: 'The file needs either a finished date column (Resolved, Completed, Closed) or a status column, so finished work can be found.', mapping, rows, columns: names };
  const { items, statuses, notes } = readItems(rows, mapping, overrides.kinds || {}, { now });
  if (!items.length) return { error: 'None of the rows had a created date that could be read.', mapping, rows, columns: names };

  // "Now" is the latest date in the file, so an export taken some weeks ago still shows its own last 26 weeks.
  const asOf = Math.min(now, latest(items));
  const live = items.filter((i) => !i.drop);
  const resolved = live.filter((i) => i.resolved != null && i.resolved <= asOf);
  const windowStart = asOf - 26 * 7 * DAY;
  const inWindow = resolved.filter((i) => i.resolved >= windowStart);
  const base = { mapping, rows, columns: names, statuses, notes, asOf, counts: { rows: rows.length - 1, items: items.length, finished: resolved.length, finishedInWindow: inWindow.length } };
  if (inWindow.length < MIN_RESOLVED) return { ...base, error: `Only ${inWindow.length} finished ${inWindow.length === 1 ? 'item' : 'items'} in the 26 weeks up to ${new Date(asOf).toISOString().slice(0, 10)}. At least ${MIN_RESOLVED} are needed to draw anything useful. Export more history, and include finished items.` };

  const open = live.filter((i) => i.resolved == null);
  const doing = open.filter((i) => i.kind === 'doing');
  const input = {
    resolved: resolved.map((i) => ({ id: i.id, created: i.created, resolved: i.resolved })),
    arrivals: items.map((i) => i.created),
    open: doing.map((i) => ({ id: i.id, status: i.status, created: i.created, updated: i.updated })),
    totals: { open: open.length, resolvedLast365: resolved.filter((i) => i.resolved >= asOf - 365 * DAY).length },
    backlog: open.length,
    history: null,
  };
  // Status history is only drawn when most items say when they started: otherwise time in progress would be guessed.
  const eligible = live.filter((i) => i.resolved != null || i.kind === 'doing').filter((i) => (i.resolved || asOf) >= windowStart);
  const withStart = eligible.filter((i) => i.started != null && i.started >= i.created && (i.resolved == null || i.started <= i.resolved));
  const coverage = eligible.length ? withStart.length / eligible.length : 0;
  let history = false;
  if (mapping.started >= 0 || withStart.length) {
    if (coverage >= START_COVERAGE) {
      history = true;
      input.history = {
        categories: null,
        items: live.map((i) => {
          const ok = i.started != null && i.started >= i.created && (i.resolved == null || i.started <= i.resolved);
          return { id: i.id, created: i.created, resolved: i.resolved, current: i.kind === 'doing' && ok ? 'In Progress' : 'To Do', changes: ok ? [{ t: i.started, from: 'To Do', to: 'In Progress' }] : [] };
        }),
      };
    } else notes.push(`Only ${Math.round(coverage * 100)}% of items have a start date, so the cumulative flow and work-in-progress-over-time charts are left out. The snapshot of work in progress by age is shown instead.`);
  } else notes.push('The file has no start dates (a Started, Activated or similar column), so the cumulative flow and work-in-progress-over-time charts are left out. The snapshot of work in progress by age is shown instead.');
  if (!doing.length) notes.push('No items are in a status grouped as "In progress", so the age chart is empty. Check the status grouping under "How the file was read".');
  const report = buildReport(input, asOf);
  return { ...base, report, history, notes: notes.slice(), coverage };
}

// The written findings, taken from the same signals the live demos fall back on. No model is involved.
export function findingTexts(facts) {
  const sg = facts && facts.signals;
  if (!sg) return null;
  const out = {};
  for (const k of ['overall', 'throughput', 'leadTime', 'workInProgress', 'cumulativeFlow', 'flow', 'forecast']) if (sg[k]) out[k] = sg[k].insight + ' ' + sg[k].experiment;
  if (sg.nextActions && sg.nextActions.length) out.summary = sg.nextActions.join(' ');
  return Object.keys(out).length ? out : null;
}
