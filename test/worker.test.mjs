import assert from 'node:assert/strict';
const DAY = 86400000, now = Date.now();
let s = 5; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
const D = (ms) => new Date(ms).toISOString().replace('Z', '+0000');
let jiraCalls = 0;
globalThis.fetch = async (url) => {
  jiraCalls++;
  const q = new URL(url).searchParams, jql = q.get('jql'), max = q.get('maxResults');
  const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ key: 'PROJ-' + (1000 + i), fields: f(i) }));
  let issues = [], total = 0;
  if (jql.includes('resolutiondate >= -196d')) { issues = mk(900, () => { const r = now - rnd() * 190 * DAY; return { created: D(r - Math.exp(rnd() * 6) * DAY), resolutiondate: D(r) }; }); total = 900; }
  else if (jql.includes('created >= -196d')) { issues = mk(500, () => ({ created: D(now - rnd() * 190 * DAY) })); total = 500; }
  else if (jql.includes('In Progress')) { issues = mk(30, () => ({ created: D(now - rnd() * 300 * DAY), status: { name: 'In Progress' } })); total = 30; }
  else total = 1234;
  if (max === '0') issues = [];
  return new Response(JSON.stringify({ total, issues }), { status: 200 });
};
const store = new Map();
globalThis.caches = { default: { match: async (r) => store.get(r.url)?.clone(), put: async (r, res) => { store.set(r.url, res); } } };
const mod = (await import('../src/index.js')).default;
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const req = () => new Request('https://example.test/api/flow');

// a model that quotes numbers straight from the figures it is given
const env = { ASSETS: { fetch: async () => new Response('asset') }, AI: { run: async (m, o) => {
  const f = JSON.parse(o.messages.at(-1).content.split('\n')[1]);
  const t = (x) => `Weekly throughput averaged ${f.throughput.weeklyAverage26} items. Hold work in progress steady.`;
  return { response: JSON.stringify({ overall: t(), throughput: t(), leadTime: `Median lead time is ${f.leadTimeDays.median26Weeks} days. Review the slowest items.`, workInProgress: `${f.workInProgress.itemsInProgress} items are in progress. Review the oldest first.`, flow: `${f.flow.raisedLast30Days} raised and ${f.flow.resolvedLast30Days} resolved in 30 days. Watch the gap.`, forecast: `At least ${f.forecastNext4Weeks.resolvedAtLeast85Percent} items likely in 4 weeks. Plan against it.`, summary: 'Focus on the oldest items and on steady throughput.' }) };
} } };

let res = await mod.fetch(req(), env, ctx);
let body = await res.json();
assert.equal(res.status, 200);
assert.equal(body.insights, null, 'first visit: numbers straight away, commentary follows');
assert.ok(body.throughput && body.leadTime.weekly && body.forecast.history && body.facts);
await Promise.all(waits);
const callsAfterFirst = jiraCalls;
res = await mod.fetch(req(), env, ctx); body = await res.json();
assert.ok(body.insights && body.insights.overall && body.insights.generatedAt, 'second visit carries the commentary');
assert.equal(jiraCalls, callsAfterFirst, 'numbers served from cache, no new Jira calls');
assert.match(res.headers.get('Cache-Control'), /max-age=120/);
assert.ok(!JSON.stringify(body).match(/assignee|reporter|displayName|JRACLOUD|atlassian|jira/i), 'payload names no person or source');

// no AI binding: charts still work, commentary is null
store.clear();
const mod2 = (await import('../src/index.js?noai')).default;
res = await mod2.fetch(req(), { ASSETS: env.ASSETS }, ctx); body = await res.json();
assert.equal(res.status, 200); assert.equal(body.insights, null);
// other paths go to the static assets
assert.equal(await (await mod.fetch(new Request('https://example.test/'), env, ctx)).text(), 'asset');
console.log('ok');
