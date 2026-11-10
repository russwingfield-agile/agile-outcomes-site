import { buildReport } from './metrics.js';
import { generateInsights } from './insights.js';

const JIRA = 'https://jira.atlassian.com';
const PROJECT = 'JRACLOUD';
const DATA_TTL = 600;            // seconds the computed numbers are reused
const INSIGHT_TTL = 600;         // seconds before the commentary is regenerated in the background
const INSIGHT_KEEP = 7 * 86400;  // the last good commentary is kept this long, as a fallback
const UA = 'AgileOutcomes-showcase/1.0 (+https://agileoutcomes.co.uk)';

async function jira(params, path = 'search') {
  const res = await fetch(JIRA + '/rest/api/2/' + path + (path === 'search' ? '?' + new URLSearchParams(params) : ''), { headers: { Accept: 'application/json', 'User-Agent': UA } });
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

// Status history for items raised in the window, items in progress now, and older items that moved in the window
// (so work carried in from before the window is counted). Only status names and dates are kept.
// Changelog pages are small, so they are fetched in parallel after the first reply says how many there are.
const HIST_CAP = 2000, HIST_PAGE = 100;
async function history(p) {
  const jql = p + ' AND (created >= -196d OR statusCategory = "In Progress" OR status CHANGED AFTER -196d)';
  const q = (startAt) => jira({ jql, fields: 'created,resolutiondate,status', expand: 'changelog', startAt: String(startAt), maxResults: String(HIST_PAGE) });
  const first = await q(0);
  const size = first.issues.length || HIST_PAGE;
  const total = Math.min(first.total || 0, HIST_CAP);
  const starts = [];
  for (let s = size; s < total; s += size) starts.push(s);
  const rest = await Promise.all(starts.map(q));
  const issues = first.issues.concat(...rest.map((r) => r.issues));
  const seen = new Set();
  const items = [];
  for (const i of issues) {
    if (seen.has(i.key)) continue;
    seen.add(i.key);
    const changes = [];
    for (const h of (i.changelog && i.changelog.histories) || []) {
      for (const it of h.items || []) if (it.field === 'status') changes.push({ t: ms(h.created), from: it.fromString, to: it.toString });
    }
    changes.sort((a, b) => a.t - b.t);
    items.push({ created: ms(i.fields.created), resolved: i.fields.resolutiondate ? ms(i.fields.resolutiondate) : null, current: i.fields.status && i.fields.status.name, changes });
  }
  // The tracker's own grouping of each status into not started, in progress or done.
  let categories = null;
  try {
    const st = await jira({}, 'status');
    categories = {};
    for (const x of st) { const k = x.statusCategory && x.statusCategory.key; categories[x.name] = k === 'done' ? 'done' : k === 'indeterminate' ? 'doing' : 'todo'; }
  } catch (e) { /* names are used instead */ }
  return { items, categories };
}
const count = async (jql) => (await jira({ jql, maxResults: '0' })).total;
const ms = (s) => Date.parse(s);

async function compute() {
  const now = Date.now();
  const p = 'project = ' + PROJECT;
  const [resolvedRaw, createdRaw, openRaw, open, resolved365, hist] = await Promise.all([
    all(p + ' AND resolutiondate >= -196d', 'created,resolutiondate'),
    all(p + ' AND created >= -196d', 'created'),
    all(p + ' AND statusCategory = "In Progress"', 'created,status', 400),
    count(p + ' AND resolution is EMPTY'),
    count(p + ' AND resolutiondate >= -365d'),
    history(p).catch(() => null), // optional: without it the page shows the snapshot views
  ]);
  return buildReport({
    resolved: resolvedRaw.map((i) => ({ created: ms(i.fields.created), resolved: ms(i.fields.resolutiondate) })).filter((r) => r.resolved),
    arrivals: createdRaw.map((i) => ms(i.fields.created)),
    open: openRaw.map((i) => ({ id: Number(String(i.key).split('-').pop()), status: i.fields.status.name, created: ms(i.fields.created) })),
    totals: { open, resolvedLast365: resolved365 },
    history: hist,
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
