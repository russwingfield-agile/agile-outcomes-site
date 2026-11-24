import { buildReport, countPlan, applyCounts } from './metrics.js';
import { generateInsights, signalTexts, INSIGHT_VERSION } from './insights.js';
import { SOURCES, DEFAULT_SOURCE } from './sources.js';

const DATA_TTL = 600;            // seconds the computed numbers are reused
const INSIGHT_TTL = 3600;        // seconds before the commentary is regenerated in the background (hourly keeps the bigger model inside the free daily allowance)
const INSIGHT_KEEP = 7 * 86400;  // the last good commentary is kept this long, as a fallback
const UA = 'AgileOutcomes-showcase/1.0 (+https://agileoutcomes.co.uk)';

// Anonymous requests to a public tracker are sometimes refused for a moment (rate limits, busy servers), so those are retried briefly.
async function jira(src, params, path = 'search') {
  const url = src.jira + '/rest/api/2/' + path + (path === 'search' ? '?' + new URLSearchParams(params) : '');
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(2000, last && last.wait ? last.wait : 400 * attempt)));
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
      if (res.ok) return await res.json();
      last = { error: new Error('Jira responded ' + res.status), wait: (Number(res.headers.get('Retry-After')) || 0) * 1000 };
      if (![429, 500, 502, 503, 504].includes(res.status)) break;
    } catch (e) { last = { error: e }; }
  }
  throw last.error;
}

// Page through a query. The page size the server actually allows is read from its reply.
async function all(src, jql, fields, cap = 3000) {
  const out = [];
  let startAt = 0;
  while (out.length < cap) {
    const j = await jira(src, { jql, fields, startAt: String(startAt), maxResults: '1000' });
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
async function history(src, p) {
  const jql = p + ' AND (created >= -196d OR statusCategory = "In Progress" OR status CHANGED AFTER -196d)';
  const q = (startAt) => jira(src, { jql, fields: 'created,resolutiondate,status', expand: 'changelog', startAt: String(startAt), maxResults: String(HIST_PAGE) });
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
    items.push({ id: idOf(i.key), created: ms(i.fields.created), resolved: i.fields.resolutiondate ? ms(i.fields.resolutiondate) : null, current: i.fields.status && i.fields.status.name, changes });
  }
  // The tracker's own grouping of each status into not started, in progress or done.
  let categories = null;
  try {
    const st = await jira(src, {}, 'status');
    categories = {};
    for (const x of st) { const k = x.statusCategory && x.statusCategory.key; categories[x.name] = k === 'done' ? 'done' : k === 'indeterminate' ? 'doing' : 'todo'; }
  } catch (e) { /* names are used instead */ }
  return { items, categories };
}
const count = async (src, jql) => (await jira(src, { jql, maxResults: '0' })).total;
const ms = (s) => Date.parse(s);
const idOf = (key) => Number(String(key).split('-').pop()); // only the number is kept: never a title or a person

async function compute(src) {
  const now = Date.now();
  const p = 'project = ' + src.project;
  const [resolvedRaw, createdRaw, openRaw, open, resolved365, hist] = await Promise.all([
    all(src, p + ' AND resolutiondate >= -196d', 'created,resolutiondate', src.cap),
    all(src, p + ' AND created >= -196d', 'created', src.cap),
    all(src, p + ' AND statusCategory = "In Progress"', 'created,status,updated', src.openCap),
    count(src, p + ' AND resolution is EMPTY'),
    count(src, p + ' AND resolutiondate >= -365d'),
    src.history ? history(src, p).catch(() => null) : null, // optional: without it the page shows the snapshot views
  ]);
  // Where open work sits, and what finished work passed through: one count each, for trackers whose workflow is worth showing.
  let pipeline = null;
  if (src.stages) {
    const [stages, passed, resolved182] = await Promise.all([
      Promise.all(src.stages.map(async (name) => ({ name, count: await count(src, p + ' AND status = "' + name + '"').catch(() => null) }))),
      Promise.all(src.passedThrough.map(async ([label, name]) => ({ label, count: await count(src, p + ' AND resolutiondate >= -182d AND status WAS "' + name + '"').catch(() => null) }))),
      count(src, p + ' AND resolutiondate >= -182d').catch(() => null),
    ]);
    if (stages.every((x) => x.count != null) && passed.every((x) => x.count != null) && resolved182) pipeline = { stages, passedThrough: passed, resolved: resolved182 };
  }
  return buildReport({
    resolved: resolvedRaw.map((i) => ({ id: idOf(i.key), created: ms(i.fields.created), resolved: ms(i.fields.resolutiondate) })).filter((r) => r.resolved),
    arrivals: createdRaw.map((i) => ms(i.fields.created)),
    open: openRaw.map((i) => ({ id: idOf(i.key), status: i.fields.status.name, created: ms(i.fields.created), updated: i.fields.updated ? ms(i.fields.updated) : null })),
    totals: { open, resolvedLast365: resolved365 },
    history: hist,
    pipeline,
    countHistory: !!src.countHistory,
  }, now);
}

// Trackers too large to read item by item get their status history from counts: how many items were in progress on each of
// a few dates. About forty small queries, so they run in their own request, are kept for an hour, and are joined to the page data.
const COUNTS_TTL = 3600;
async function computeCounts(src) {
  const now = Date.now();
  const plan = countPlan(now);
  const p = 'project = ' + src.project;
  const names = src.doing.map((n) => '"' + n + '"').join(', ');
  const on = (d) => (d === plan.today ? 'status IN (' + names + ')' : 'status WAS IN (' + names + ') ON "' + d + '"');
  const jobs = [
    ...plan.cohortDays.map((d) => ['cohort', d, p + ' AND created >= "' + plan.start + '" AND ' + on(d)]),
    ...plan.weeks.map((w) => ['wip', w.date, p + ' AND ' + on(w.date)]),
  ];
  const out = await Promise.all(jobs.map(([k, d, jql]) => count(src, jql).then((n) => [k, d, n], () => [k, d, null])));
  const failed = out.filter((x) => x[2] == null).length;
  if (failed > 6) throw new Error('too many history queries failed');
  const counts = { generatedAt: new Date(now).toISOString(), cohort: {}, wip: {} };
  for (const [k, d, n] of out) if (n != null) counts[k][d] = n;
  return counts;
}
async function getCounts(request, id, src, allowFetch) {
  const mem = memFor(id);
  const fresh = (c) => c && Date.now() - Date.parse(c.generatedAt) < COUNTS_TTL * 1000;
  if (fresh(mem.counts)) return mem.counts;
  const cached = await readCache(request, 'counts' + suffix(id));
  if (fresh(cached)) { mem.counts = cached; return cached; }
  const older = mem.counts || cached || null; // older counts still draw: the dates they cover are matched to the page's own
  if (!allowFetch) return older;
  try {
    if (!mem.countsBusy) {
      mem.countsBusy = computeCounts(src).then(async (c) => { mem.counts = c; await writeCache(request, 'counts' + suffix(id), c, INSIGHT_KEEP); return c; }).finally(() => { mem.countsBusy = null; });
    }
    return await mem.countsBusy;
  } catch (e) { return older; }
}

/* ---- two layers of memory: this isolate (fast), and the Cloudflare cache (shared where available) ---- */
const memory = {};
const memFor = (id) => (memory[id] = memory[id] || { data: null, dataAt: 0, ins: null, busy: false });
const suffix = (id) => (id === DEFAULT_SOURCE ? '' : '-' + id); // the original source keeps its original cache names
const cacheUrl = (request, name) => new Request(new URL('/__cache/' + name, request.url).toString());
async function readCache(request, name) { try { const r = await caches.default.match(cacheUrl(request, name)); return r ? await r.json() : null; } catch (e) { return null; } }
async function writeCache(request, name, obj, ttl) {
  try { await caches.default.put(cacheUrl(request, name), new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + ttl } })); } catch (e) { /* no cache available: the memory layer still works */ }
}

async function getData(request, id, src) {
  const mem = memFor(id);
  const fresh = (d, at) => d && Date.now() - at < DATA_TTL * 1000;
  if (fresh(mem.data, mem.dataAt)) return mem.data;
  const cached = await readCache(request, 'data' + suffix(id));
  if (cached && fresh(cached, Date.parse(cached.generatedAt))) { mem.data = cached; mem.dataAt = Date.parse(cached.generatedAt); return cached; }
  try {
    const data = await compute(src);
    mem.data = data; mem.dataAt = Date.now();
    await writeCache(request, 'data' + suffix(id), data, DATA_TTL);
    return data;
  } catch (e) {
    if (mem.data) return mem.data; // never fail the page when we have something older
    if (cached) return cached;
    throw e;
  }
}

// Commentary is produced here, when the numbers change, never per visitor and never from the browser.
async function getInsights(request, env, ctx, data, id) {
  const mem = memFor(id);
  if (!mem.ins) mem.ins = await readCache(request, 'insights' + suffix(id));
  if (mem.ins && mem.ins.v !== INSIGHT_VERSION) mem.ins = null; // commentary written by an older prompt is not shown
  const missing = !!(data.facts && data.facts.cumulativeFlow && mem.ins && mem.ins.text && !mem.ins.text.cumulativeFlow); // history arrived after the commentary was written
  const stale = !mem.ins || missing || Date.now() - Date.parse(mem.ins.generatedAt) > INSIGHT_TTL * 1000;
  if (stale && env.AI && !mem.busy) {
    mem.busy = true;
    ctx.waitUntil((async () => {
      try {
        const r = await generateInsights(env, data.facts);
        if (r) { mem.ins = { ...r, v: INSIGHT_VERSION, generatedAt: new Date().toISOString() }; await writeCache(request, 'insights' + suffix(id), mem.ins, INSIGHT_KEEP); }
      } finally { mem.busy = false; }
    })());
  }
  return mem.ins;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

async function flow(request, env, ctx) {
  try {
    const q = new URL(request.url).searchParams;
    const asked = q.get('p');
    const id = Object.prototype.hasOwnProperty.call(SOURCES, asked) ? asked : DEFAULT_SOURCE;
    const src = SOURCES[id];
    let data = await getData(request, id, src);
    let pending = false;
    if (src.countHistory) {
      const wanted = q.get('h') === '1'; // the page asks for the history in a second, separate request
      const counts = await getCounts(request, id, src, wanted);
      if (counts) data = applyCounts(data, counts, Date.parse(data.generatedAt));
      pending = !data.cfd && !wanted;
    }
    const ins = await getInsights(request, env, ctx, data, id);
    // If the model has not produced commentary (yet, or at all), the findings worked out from the figures are shown instead.
    const fallback = signalTexts(data.facts);
    const text = { ...(fallback || {}), ...(ins ? ins.text : {}) };
    const { cfdBase, ...rest } = data;
    const body = { ...rest, historyPending: pending, insights: Object.keys(text).length ? { ...text, generatedAt: ins ? ins.generatedAt : data.generatedAt } : null };
    return new Response(JSON.stringify(body), { headers: { ...JSON_HEADERS, 'Cache-Control': pending ? 'public, max-age=10' : 'public, max-age=120' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'unavailable', detail: String((e && e.message) || e).slice(0, 200) }), { status: 502, headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store' } });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/api/flow' && request.method === 'GET') return flow(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
