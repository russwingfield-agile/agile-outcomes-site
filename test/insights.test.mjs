import assert from 'node:assert/strict';
import { buildReport } from '../public/lib/metrics.js';
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
  throughput: `Weekly throughput averaged ${f.throughput.weeklyAverage26} over 26 weeks. Cap work in progress for four weeks and compare lead time.`,
  leadTime: `Median lead time is ${f.leadTimeDays.median26Weeks} days and the 85th percentile is ${f.leadTimeDays.p85Of26Weeks} days. Trace the five slowest items and find the shared wait.`,
  workInProgress: `${f.workInProgress.itemsInProgress} items are in progress and ${f.workInProgress.itemsOlderThanP85LeadTime} are older than the 85th percentile lead time. Finish, split or close those items this week.`,
  flow: `${f.flow.raisedLast30Days} items were raised and ${f.flow.resolvedLast30Days} resolved in the last 30 days. Agree an intake limit and compare the gap in four weeks.`,
  forecast: `At least ${f.forecastNext4Weeks.resolvedAtLeast85Percent} items are likely to be resolved in the next 4 weeks at 85% confidence. Commit to that figure and re-forecast every Monday.`,
  summary: 'Finish or close the oldest in-progress items this week. Compare median lead time in four weeks.',
};
const ai = (replies) => { let i = 0; return { run: async () => ({ response: typeof replies[i] === 'string' ? replies[i++] : JSON.stringify(replies[i++ % replies.length]) }) }; };

assert.ok(validate(good, facts).ok, JSON.stringify(validate(good, facts)));
// invented number is rejected
assert.ok(!validate({ ...good, throughput: 'Throughput grew by 73.1% in a fortnight. Keep going and do more.' }, facts).ok);
// generic advice is rejected
assert.ok(!validate({ ...good, summary: 'Focus on the oldest items and continue to monitor throughput each week.' }, facts).ok);
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
// the prompt carries the signals, and the model may reuse numbers that appear only inside them
assert.ok(facts.signals && facts.signals.overall && facts.signals.nextActions.length);
assert.match(prompt, /nextActions/);
for (const [k, v] of Object.entries(facts.signals)) if (k !== 'nextActions') assert.ok(v.insight && v.experiment, k);
const nums = (facts.signals.forecast.insight.match(/\d+/g) || []).filter((x) => +x > 20)[0];
assert.ok(validate({ ...good, forecast: `Plan on ${nums} items. Commit to ${nums} and re-forecast every Monday.` }, facts).ok);
console.log('ok');
