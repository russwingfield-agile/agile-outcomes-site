import assert from 'node:assert/strict';
import { parseCsv, detectColumns, makeDateParser, buildYourReport, findingTexts, guessKind } from '../public/lib/csv.js';
import { jiraCsv, linearCsv } from '../public/lib/sample.js';

const now = Date.parse('2026-11-24T12:00:00Z');

// --- CSV text: quotes, doubled quotes, line breaks inside cells, BOM, other delimiters
{
  const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"line one\nline two",z\r\n\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', 'line one\nline two', 'z']]);
  assert.deepEqual(parseCsv('a;b\n1;2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n1,'), [['a', 'b'], ['1', '']]);
  console.log('csv text ok');
}

// --- dates
{
  const p = makeDateParser('dmy');
  const t = Date.UTC(2026, 2, 13, 9, 41);
  assert.equal(p('13/Mar/26 9:41 AM'), t);
  assert.equal(p('13/Mar/2026 9:41 AM'), t);
  assert.equal(p('13/Mar/26 9:41 PM'), t + 12 * 3600000);
  assert.equal(p('12/Mar/26 12:05 AM'), Date.UTC(2026, 2, 12, 0, 5));
  assert.equal(p('2026-03-13T09:41:00.000Z'), t);
  assert.equal(p('2026-03-13 09:41'), t);
  assert.equal(p('2026-03-13T10:41:00+01:00'), t);
  assert.equal(p('13/03/2026 09:41'), t);
  assert.equal(makeDateParser('mdy')('03/13/2026 09:41'), t);
  assert.equal(p('Mar 13, 2026 9:41 AM'), t);
  assert.equal(p('13 March 2026'), Date.UTC(2026, 2, 13));
  assert.equal(p('Fri Mar 13 2026 09:41:00 GMT+0000 (Coordinated Universal Time)'), t);
  assert.equal(p(''), null);
  assert.equal(p('not a date'), null);
  assert.equal(p('1/1/1970'), null); // outside a sensible range
  console.log('dates ok');
}

// --- column detection copes with the repeated names in a real Jira export
{
  const c = detectColumns(['Summary', 'Issue key', 'Issue id', 'Status', 'Created', 'Updated', 'Resolved', 'Labels', 'Labels', 'Status Category', 'Status Category Changed', 'Resolution']);
  assert.equal(c.key, 1); assert.equal(c.created, 4); assert.equal(c.resolved, 6); assert.equal(c.status, 3); assert.equal(c.category, 9); assert.equal(c.categoryChanged, 10); assert.equal(c.resolution, 11); assert.equal(c.started, -1);
  const l = detectColumns(['ID', 'Title', 'Status', 'Created', 'Updated', 'Started', 'Completed', 'Canceled']);
  assert.equal(l.key, 0); assert.equal(l.started, 5); assert.equal(l.resolved, 6); assert.equal(l.canceled, 7);
  const a = detectColumns(['ID', 'Work Item Type', 'State', 'Created Date', 'Activated Date', 'Closed Date', 'Changed Date']);
  assert.equal(a.status, 2); assert.equal(a.created, 3); assert.equal(a.started, 4); assert.equal(a.resolved, 5); assert.equal(a.updated, 6);
  assert.equal(guessKind('Selected for Development'), 'todo');
  assert.equal(guessKind('In Review'), 'doing');
  assert.equal(guessKind("Won't Do"), 'skip');
  assert.equal(guessKind('Done'), 'done');
  console.log('columns ok');
}

// --- Jira-style example: no start dates, so no status history, but everything else
{
  const rows = parseCsv(jiraCsv(now));
  assert.equal(rows[0].length, 21);
  assert.ok(rows.every((r) => r.length === 21), 'every row has the same width, even with multi-line descriptions');
  const r = buildYourReport(rows, {}, { now });
  assert.ok(!r.error, r.error);
  assert.equal(r.history, false);
  assert.equal(r.report.cfd, null);
  assert.equal(r.report.forecast.target, r.report.totals.open, 'the forecast clears the real open backlog');
  assert.ok(r.counts.finishedInWindow >= 100);
  assert.ok(r.statuses.some((s) => s.name === 'In Review' && s.kind === 'doing'));
  assert.ok(r.notes.some((n) => /closed without being delivered/.test(n)));
  assert.ok(r.notes.some((n) => /start date/.test(n)));
  assert.match(String(r.report.age.items[0].id), /^PAY-\d+$/);
  const texts = findingTexts(r.report.facts);
  assert.ok(texts.overall && texts.throughput && texts.summary);
  // the example is built to show a review queue
  assert.equal(r.report.facts.signals.workInProgress.id, 'stuck-in-status');
  // nothing from titles, descriptions or people reaches the report
  const dump = JSON.stringify(r.report);
  assert.ok(!/Alex Morgan|Sam Rivera|Steps to reproduce|webhook/.test(dump));
  console.log('jira example ok:', r.counts.items, 'items,', r.counts.finishedInWindow, 'finished in window');
}

// --- Linear-style example: start dates, so status history is drawn
{
  const r = buildYourReport(parseCsv(linearCsv(now)), {}, { now });
  assert.ok(!r.error, r.error);
  assert.equal(r.history, true);
  assert.ok(r.report.cfd && r.report.wip);
  const last = r.report.cfd.days[r.report.cfd.days.length - 1];
  assert.ok(last.todo > 0 && last.doing > 0 && last.done > 0);
  assert.ok(r.statuses.some((s) => s.name === 'Duplicate' && s.kind === 'skip'));
  assert.ok(r.report.facts.cumulativeFlow);
  console.log('linear example ok');
}

// --- the visitor can regroup statuses and remap columns
{
  const rows = parseCsv(jiraCsv(now));
  const base = buildYourReport(rows, {}, { now });
  const re = buildYourReport(rows, { kinds: { 'In Review': 'todo' } }, { now });
  assert.equal(re.report.age.count, base.report.age.count - base.statuses.find((s) => s.name === 'In Review').count);
  const odd = parseCsv('When,What\n2026-11-01,x\n');
  const bad = buildYourReport(odd, {}, { now });
  assert.match(bad.error, /No created date column/);
  assert.ok(bad.columns.includes('When'));
  const fixed = buildYourReport(odd, { mapping: { created: 0 } }, { now });
  assert.ok(fixed.error && !/No created date column/.test(fixed.error)); // gets further, then asks for a status or finished column
  console.log('overrides ok');
}

// --- an old export shows its own last 26 weeks, not an empty "now"
{
  const then = now - 120 * 86400000;
  const r = buildYourReport(parseCsv(jiraCsv(then)), {}, { now });
  assert.ok(!r.error, r.error);
  assert.ok(Math.abs(r.asOf - then) < 2 * 86400000);
  assert.ok(r.counts.finishedInWindow >= 100);
  console.log('as-of ok');
}

// --- ambiguous numeric dates are read day first and say so; unambiguous ones are detected
{
  const mk = (a, b) => 'Issue key,Created,Resolved,Status\n' + Array.from({ length: 30 }, (_, i) => `A-${i},${a},${b},Done`).join('\n');
  const day = buildYourReport(parseCsv(mk('13/10/2026', '20/10/2026')), {}, { now });
  assert.ok(day.notes.some((n) => /day first/.test(n)));
  const mon = buildYourReport(parseCsv(mk('10/13/2026', '10/20/2026')), {}, { now });
  assert.ok(mon.notes.some((n) => /month first/.test(n)));
  const amb = buildYourReport(parseCsv(mk('03/04/2026', '10/04/2026')), {}, { now });
  assert.ok(amb.notes.some((n) => /ambiguous/.test(n)));
  console.log('date order ok');
}

// --- a file with only a finished date and status still works; done items without a date borrow Updated
{
  const lines = ['Key,Created,Updated,Status'];
  for (let i = 0; i < 40; i++) lines.push(`K-${i},2026-0${1 + (i % 5)}-10,2026-1${i % 2}-0${1 + (i % 9)},${i % 4 ? 'Done' : 'In Progress'}`);
  const r = buildYourReport(parseCsv(lines.join('\n')), {}, { now });
  assert.ok(!r.error, r.error);
  assert.ok(r.notes.some((n) => /last updated date was used/.test(n)));
  console.log('fallback ok');
}
console.log('all csv tests ok');
