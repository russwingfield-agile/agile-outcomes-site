import { buildReport } from './metrics.js';

const JIRA = 'https://jira.atlassian.com';
const PROJECT = 'JRACLOUD';
const TTL = 600; // seconds a computed report is shared between visitors
const UA = 'AgileOutcomes-showcase/1.0 (+https://agileoutcomes.co.uk)';

async function jira(params) {
  const url = JIRA + '/rest/api/2/search?' + new URLSearchParams(params);
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error('Jira responded ' + res.status);
  return res.json();
}

// Page through a query. The page size the server actually allows is read from its reply.
async function all(jql, fields, cap = 3000) {
  const out = [];
  let startAt = 0;
  while (out.length < cap) {
    const j = await jira({ jql, fields, startAt: String(startAt), maxResults: '1000' });
    out.push(...j.issues);
    startAt += j.issues.length;
    if (!j.issues.length || startAt >= j.total) break;
  }
  return out;
}
const count = async (jql) => (await jira({ jql, maxResults: '0' })).total;
const ms = (s) => Date.parse(s);

async function compute() {
  const now = Date.now();
  const p = 'project = ' + PROJECT;
  const [resolvedRaw, createdRaw, openRaw, open, resolved365] = await Promise.all([
    all(p + ' AND resolutiondate >= -196d', 'created,resolutiondate'),
    all(p + ' AND created >= -90d', 'created'),
    all(p + ' AND statusCategory = "In Progress"', 'created,status', 400),
    count(p + ' AND resolution is EMPTY'),
    count(p + ' AND resolutiondate >= -365d'),
  ]);
  return buildReport({
    resolved: resolvedRaw.map((i) => ({ created: ms(i.fields.created), resolved: ms(i.fields.resolutiondate) })).filter((r) => r.resolved),
    arrivals: createdRaw.map((i) => ms(i.fields.created)),
    open: openRaw.map((i) => ({ key: i.key, status: i.fields.status.name, created: ms(i.fields.created) })),
    totals: { open, resolvedLast365: resolved365 },
  }, now);
}

async function flow(request, ctx) {
  const cache = caches.default;
  const key = new Request(new URL('/api/flow', request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  try {
    const res = new Response(JSON.stringify(await compute()), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + TTL },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'The Jira data could not be loaded just now.' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/api/flow' && request.method === 'GET') return flow(request, ctx);
    return env.ASSETS.fetch(request);
  },
};
