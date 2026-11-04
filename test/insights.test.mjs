import assert from 'node:assert/strict';
import { buildReport } from '../src/metrics.js';
import { generateInsights, validate, KEYS, buildMessages } from '../src/insights.js';
const DAY = 86400000, now = Date.UTC(2026, 10, 4, 12);
let s = 3; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
const resolved = [], arrivals = [], open = [];
for (let i = 0; i < 900; i++) { const r = now - rnd() * 190 * DAY; resolved.push({ resolved: r, created: r - Math.exp(rnd() * 6) * DAY }); }
for (let i = 0; i < 600; i++) arrivals.push(now - rnd() * 190 * DAY);
for (let i = 0; i < 30; i++) open.push({ id: 100 + i, status: 'In Progress', created: now - rnd() * 300 * DAY });
const { facts } = buildReport({ resolved, arrivals, open, totals: { open: 1, resolvedLast365: 1 } }, now);
const f = facts;
const good = {
  overall: `Throughput ${f.throughput.direction} to ${f.throughput.last4WeeksAverage} items a week over the last 4 weeks, against ${f.throughput.previous8WeeksAverage} before. Open work ${f.flow.last30DaysDirection} in the last 30 days.`,
  throughput: `Weekly throughput averaged ${f.throughput.weeklyAverage26} over 26 weeks. Protect the steady weeks by limiting work in progress.`,
  leadTime: `Median lead time is ${f.leadTimeDays.median26Weeks} days and the 85th percentile is ${f.leadTimeDays.p85Of26Weeks} days. Look at the slowest 15% of items first.`,
  workInProgress: `${f.workInProgress.itemsInProgress} items are in progress and ${f.workInProgress.itemsOlderThanP85LeadTime} are older than the 85th percentile lead time. Review those items this week.`,
  flow: `${f.flow.raisedLast30Days} items were raised and ${f.flow.resolvedLast30Days} resolved in the last 30 days. Keep an eye on the gap between the two.`,
  forecast: `At least ${f.forecastNext4Weeks.resolvedAtLeast85Percent} items are likely to be resolved in the next 4 weeks at 85% confidence. Plan commitments against that figure.`,
  summary: 'Focus on the oldest in-progress items and on keeping throughput steady.',
};
const ai = (replies) => { let i = 0; return { run: async () => ({ response: typeof replies[i] === 'string' ? replies[i++] : JSON.stringify(replies[i++ % replies.length]) }) }; };

assert.ok(validate(good, facts).ok, JSON.stringify(validate(good, facts)));
// invented number is rejected
assert.ok(!validate({ ...good, throughput: 'Throughput grew by 73.1% in a fortnight. Keep going and do more.' }, facts).ok);
// names a source is rejected
assert.ok(!validate({ ...good, summary: 'Atlassian should focus on the oldest items in progress.' }, facts).ok);
assert.deepEqual(Object.keys(good), KEYS);

let r = await generateInsights({ AI: ai([good]) }, facts);
assert.equal(r.text.overall, good.overall);
// code fences and chatter around the JSON are tolerated
r = await generateInsights({ AI: ai(['Here you go:\n```json\n' + JSON.stringify(good) + '\n```']) }, facts);
assert.ok(r);
// first reply invalid, second fixes it (and the retry carries feedback)
let seen = []; r = await generateInsights({ AI: { run: async (m, o) => { seen.push(o.messages.at(-1).content); return { response: JSON.stringify(seen.length === 1 ? { ...good, flow: 'Raised 9999 items.' } : good) }; } } }, facts);
assert.ok(r); assert.match(seen[1], /rejected/);
// never valid, or the model throws, or there is no binding: null, so the page shows charts without commentary
assert.equal(await generateInsights({ AI: ai([{ ...good, flow: 'Raised 9999 items.' }]) }, facts), null);
assert.equal(await generateInsights({ AI: { run: async () => { throw new Error('daily limit'); } } }, facts), null);
assert.equal(await generateInsights({}, facts), null);
// the prompt carries no people data and no source name
const prompt = JSON.stringify(buildMessages(facts));
assert.ok(!/assignee|reporter|displayName|jira|atlassian|JRACLOUD/i.test(prompt.replace(/Never mention any company, product, tracker or data source name\./, '')));
console.log('prompt chars', prompt.length);
console.log('ok');
