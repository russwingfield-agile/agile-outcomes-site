import { buildReport } from './metrics.js';
import { generateInsights } from './insights.js';
import { all, count, jira, statusGroups, jqlList, PROJECT } from './jira.js';
import { BANDS, planDates, missingCells, fillCells, assemble, cfdFacts } from './cfd.js';

const DATA_TTL = 600;            // seconds the computed numbers are reused
const INSIGHT_TTL = 600;         // seconds before the commentary is regenerated in the background
const INSIGHT_KEEP = 7 * 86400;  // the last good commentary is kept this long, as a fallback
const CFD_KEEP = 86400;          // past flow cells never change, so they are kept a day
const ms = (s) => Date.parse(s);

async function compute(groups) {
  const now = Date.now();
  const p = 'project = ' + PROJECT;
  const active = groups && groups.active.length ? groups.active : null;
  const [resolvedRaw, createdRaw, openRaw, open, resolved365, neverActive] = await Promise.all([
    all(p + ' AND resolutiondate >= -196d', 'created,resolutiondate'),
    all(p + ' AND created >= -196d', 'created'),
    all(p + ' AND statusCategory = "In Progress"', 'created,status', 400),
    count(p + ' AND resolution is EMPTY'),
    count(p + ' AND resolutiondate >= -365d'),
    active ? count(p + ' AND resolutiondate >= -365d AND status WAS IN (' + jqlList(active) + ')').catch(() => null) : Promise.resolve(null),
  ]);
  return buildReport({
    resolved: resolvedRaw.map((i) => ({ created: ms(i.fields.created), resolved: ms(i.fields.resolutiondate) })).filter((r) => r.resolved),
    arrivals: createdRaw.map((i) => ms(i.fields.created)),
    open: openRaw.map((i) => ({ id: Number(String(i.key).split('-').pop()), status: i.fields.status.name, created: ms(i.fields.created) })),
    totals: { open, resolvedLast365: resolved365, resolvedLast365WorkedOn: neverActive == null ? null : resolved365 - neverActive },
  }, now);
}

/* ---- two layers of memory: this isolate (fast), and the Cloudflare cache (shared where available) ---- */
const mem = { data: null, dataAt: 0, ins: null, busy: false, groups: null, cfd: null, cfdBusy: false };
const cacheUrl = (request, name) => new Request(new URL('/__cache/' + name, request.url).toString());
async function readCache(request, name) { try { const r = await caches.default.match(cacheUrl(request, name)); return r ? await r.json() : null; } catch (e) { return null; } }
async function writeCache(request, name, obj, ttl) {
  try { await caches.default.put(cacheUrl(request, name), new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + ttl } })); } catch (e) { /* no cache available: the memory layer still works */ }
}

async function getGroups() {
  if (mem.groups) return mem.groups;
  try { mem.groups = await statusGroups(); } catch (e) { /* the flow chart and funnel figure just wait */ }
  return mem.groups;
}

async function getData(request) {
  const fresh = (d, at) => d && Date.now() - at < DATA_TTL * 1000;
  if (fresh(mem.data, mem.dataAt)) return mem.data;
  const cached = await readCache(request, 'data');
  if (cached && fresh(cached, Date.parse(cached.generatedAt))) { mem.data = cached; mem.dataAt = Date.parse(cached.generatedAt); return cached; }
  try {
    const data = await compute(await getGroups());
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
        const facts = { ...data.facts };
        if (mem.cfd && mem.cfd.complete) facts.itemsRaisedInPeriod = mem.cfd.facts;
        const r = await generateInsights(env, facts);
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

// Where the items raised in the last 26 weeks stand, fortnight by fortnight. Filled a batch at a time and cached.
async function cfd(request) {
  const now = Date.now();
  try {
    const groups = await getGroups();
    if (!groups || !groups.done.length) throw new Error('no statuses');
    const plan = planDates(now);
    let state = mem.cfd && mem.cfd.start === plan.start ? mem.cfd : await readCache(request, 'cfd');
    if (!state || state.start !== plan.start) state = { start: plan.start, cells: {}, nowAt: 0, complete: false };
    if (!state.nowAt || now - state.nowAt > DATA_TTL * 1000) { for (const b of BANDS) delete state.cells['now|' + b]; state.nowAt = 0; }
    const todo = missingCells(plan, state.cells);
    if (todo.length && !mem.cfdBusy) {
      mem.cfdBusy = true;
      try {
        await fillCells(todo, groups, plan.start, state.cells);
        if (BANDS.every((b) => state.cells['now|' + b] != null)) state.nowAt = now;
        await writeCache(request, 'cfd', state, CFD_KEEP);
      } finally { mem.cfdBusy = false; }
    }
    const left = missingCells(plan, state.cells).length;
    const total = (plan.dates.length - 1) * 4 + 4;
    state.complete = left === 0;
    mem.cfd = state;
    if (!state.complete) return json({ complete: false, progress: Math.round(((total - left) / total) * 100) }, 5);
    const points = assemble(plan, state.cells, new Date(now).toISOString().slice(0, 10));
    state.facts = cfdFacts(points);
    return json({ complete: true, start: plan.start, points }, 120);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'unavailable' }), { status: 502, headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store' } });
  }
}
const json = (obj, ttl) => new Response(JSON.stringify(obj), { headers: { ...JSON_HEADERS, 'Cache-Control': 'public, max-age=' + ttl } });

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/api/flow') return flow(request, env, ctx);
    if (request.method === 'GET' && path === '/api/cfd') return cfd(request);
    return env.ASSETS.fetch(request);
  },
};
