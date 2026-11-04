import assert from 'node:assert/strict';
import { groupStatuses, jqlList } from '../src/jira.js';
import { planDates, cellJql, cellKey, missingCells, assemble, cfdFacts, BANDS } from '../src/cfd.js';

const groups = groupStatuses([
  { name: 'Bug', statuses: [
    { name: 'Needs Triage', statusCategory: { key: 'new' } }, { name: 'Gathering Impact', statusCategory: { key: 'new' } },
    { name: 'Long Term Backlog', statusCategory: { key: 'new' } }, { name: 'Short Term Backlog', statusCategory: { key: 'new' } },
    { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, { name: 'In Review', statusCategory: { key: 'indeterminate' } },
    { name: 'Closed', statusCategory: { key: 'done' } } ] },
  { name: 'Suggestion', statuses: [{ name: 'Gathering Interest', statusCategory: { key: 'new' } }, { name: 'Under Consideration', statusCategory: { key: 'new' } }, { name: 'Closed', statusCategory: { key: 'done' } }] },
]);
assert.deepEqual(groups.untriaged.sort(), ['Gathering Impact', 'Gathering Interest', 'Needs Triage']);
assert.deepEqual(groups.backlog.sort(), ['Long Term Backlog', 'Short Term Backlog', 'Under Consideration']);
assert.deepEqual(groups.active.sort(), ['In Progress', 'In Review']);
assert.deepEqual(groups.done, ['Closed']);

const now = Date.UTC(2026, 10, 4, 12);
const plan = planDates(now);
assert.equal(plan.start, '2026-05-04');
assert.equal(plan.dates[0], '2026-05-04');
assert.equal(plan.dates.at(-1), '2026-11-02');            // this week's Monday
assert.equal(plan.dates.length, 14);

assert.equal(cellJql('active', groups.active, plan.start, '2026-09-14'),
  'project = JRACLOUD AND created >= "2026-05-04" AND created < "2026-09-14" AND status WAS IN ("In Progress", "In Review") ON "2026-09-14"');
assert.equal(cellJql('done', ['Closed'], plan.start, 'now'), 'project = JRACLOUD AND created >= "2026-05-04" AND status IN ("Closed")');
assert.equal(cellJql('active', [], plan.start, 'now'), null);
assert.equal(jqlList(['A "quoted" name']), '"A quoted name"');

assert.equal(missingCells(plan, {}).length, 13 * 4 + 4);   // the first date is zero by definition
const cells = {};
for (const d of [...plan.dates.slice(1), 'now']) BANDS.forEach((b, i) => { cells[cellKey(d, b)] = 10 + i; });
assert.equal(missingCells(plan, cells).length, 0);
delete cells['now|done'];
assert.equal(missingCells(plan, cells).length, 1);
cells['now|done'] = 40;
const pts = assemble(plan, cells, '2026-11-04');
assert.equal(pts.length, 15);
assert.equal(pts[0].total, 0);
assert.equal(pts.at(-1).total, 10 + 11 + 12 + 40);
assert.equal(pts.at(-1).now, true);
const f = cfdFacts(pts);
assert.equal(f.raisedInPeriod, 73);
assert.equal(f.stillUntriagedPercent + f.inBacklogPercent + f.beingWorkedPercent + f.closedPercent >= 99, true);
console.log('ok');
