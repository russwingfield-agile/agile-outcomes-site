import { buildReport } from './metrics.js';
import { generateInsights } from './insights.js';

const JIRA = 'https://jira.atlassian.com';
const PROJECT = 'JRACLOUD';
const DATA_TTL = 600;            // seconds the computed numbers are reused
const INSIGHT_TTL = 600;         // seconds before the commentary is regenerated in the background
const INSIGHT_KEEP = 7 * 86400;  // the last good commentary is kept this long, as a fallback
const UA = 'AgileOutcomes-showcase/1.0 (+https://agileoutcomes.co.uk)';

async function jira(params) {
  const res = await fetch(JIRA + '/rest/api/2/search?' + new URLSearchParams(params), { headers: { Accept: 'application/json', 'User-Agent': UA } });
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
    all(p + ' AND created >= -196d', 'created'),
    all(p + ' AND statusCategory = "In Progress"', 'created,status', 400),
    count(p + ' AND resolution is EMPTY'),
    count(p + ' AND resolutiondate >= -365d'),
  ]);
  return buildReport({
    resolved: resolvedRaw.map((i) => ({ created: ms(i.fields.created), resolved: ms(i.fields.resolutiondate) })).filter((r) => r.resolved),
    arrivals: createdRaw.map((i) => ms(i.fields.created)),
    open: openRaw.map((i) => ({ id: Number(String(i.key).split('-').pop()), status: i.fields.status.name, created: ms(i.fields.created) })),
    totals: { open, resolvedLast365: resolved365 },
  }, now);
}

/* ---- two layers of memory: this isolate (fast), and the Cloudflare cache (shared where available) ---- */
const mem = { data: null, dataAt: 0, ins: null, busy: false };
const cacheUrl = (request, name) => new Request(new URL('/__cache/' + name, request.url).toString());
async function readCache(request, name) { try { const r = await caches.default.match(cacheUrl(request, name)); return r ? await r.json() : null; } catch (e) { return null; } }
async function writeCache(request, name, obj, ttl) {
  try { await caches.default.put(cacheUrl(request, name), new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + ttl } })); } catch (e) { /* no cache available: the memory layer still works */ }
}

async function getData(request) {
  const fresh = (d, at) => d && Date.now() - at < DATA_TTL * 1000;
  if (fresh(mem.data, mem.dataAt)) return mem.data;
  const cached = await readCache(request, 'data');
  if (cached && fresh(cached, Date.parse(cached.generatedAt))) { mem.data = cached; mem.dataAt = Date.parse(cached.generatedAt); return cached; }
  try {
    const data = await compute();
    mem.data = data; mem.dataAt = Date.now();
    await writeCache(request, 'data', data, DATA_TTL);
    return data;
  } catch (e) {
    if (mem.data) return mem.data; // never fail the page when we have something older
    if (cached) return cached;
    throw e;
  }
}

// Commentary is produced here, when the numbers change, never per visitor and never from the browser.
async function getInsights(request, env, ctx, data) {
  if (!mem.ins) mem.ins = await readCache(request, 'insights');
  const stale = !mem.ins || Date.now() - Date.parse(mem.ins.generatedAt) > INSIGHT_TTL * 1000;
  if (stale && env.AI && !mem.busy) {
    mem.busy = true;
    ctx.waitUntil((async () => {
      try {
        const r = await generateInsights(env, data.facts);
        if (r) { mem.ins = { ...r, generatedAt: new Date().toISOString() }; await writeCache(request, 'insights', mem.ins, INSIGHT_KEEP); }
      } finally { mem.busy = false; }
    })());
  }
  return mem.ins;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

async function flow(request, env, ctx) {
  try {
    const data = await getData(request);
    const ins = await getInsights(request, env, ctx, data);
    const body = { ...data, insights: ins ? { ...ins.text, generatedAt: ins.generatedAt } : null };
    return new Response(JSON.stringify(body), { headers: { ...JSON_HEADERS, 'Cache-Control': 'public, max-age=120' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'unavailable' }), { status: 502, headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store' } });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/api/flow' && request.method === 'GET') return flow(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
