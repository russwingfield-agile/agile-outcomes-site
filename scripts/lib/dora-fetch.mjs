// Fetches the raw data for the release metrics from Jira and GitHub and reduces it to the records `analyse` needs.
// It runs in Node (locally or in a scheduled job), never in the Worker: a year of pull requests is dozens of pages,
// far beyond what a Worker request on the free plan may do. The fetch function is injected so tests can fake it.
// Only keys, priorities, version names and dates are kept. Titles are read to find a ticket key and then dropped.

import { keysIn, RELEASE_NAME, DAY, LOOKBACK_DAYS } from '../../public/lib/dora.js';

const UA = 'AgileOutcomes-release-metrics/1.0 (+https://agileoutcomes.co.uk)';
const ms = (s) => (s ? Date.parse(s) : null);
const sleep = (t) => new Promise((r) => setTimeout(r, t));

async function getJson(fetchFn, url, headers, { tries = 3, log } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(Math.min(8000, 700 * i * i));
    try {
      const res = await fetchFn(url, { headers: { Accept: 'application/json', 'User-Agent': UA, ...headers } });
      if (res.ok) return { json: await res.json(), headers: res.headers };
      const remaining = res.headers && res.headers.get && res.headers.get('x-ratelimit-remaining');
      if (res.status === 403 && remaining === '0') { const e = new Error('GitHub rate limit reached. Set GITHUB_TOKEN to raise it from 60 to 5,000 requests an hour.'); e.rateLimited = true; throw e; }
      last = new Error(res.status + ' from ' + new URL(url).host + new URL(url).pathname);
      if (![429, 500, 502, 503, 504].includes(res.status)) { last.fatal = true; break; }
    } catch (e) { if (e.rateLimited) throw e; last = e; }
  }
  if (log) log('request failed: ' + last.message);
  throw last;
}

// Jira search results, all pages. The page size the server allows is read from its reply.
async function jiraSearch(fetchFn, cfg, jql, fields, cap = 8000) {
  const out = [];
  let startAt = 0;
  while (out.length < cap) {
    const url = cfg.jira + '/rest/api/2/search?' + new URLSearchParams({ jql, fields, startAt: String(startAt), maxResults: '1000' });
    const { json } = await getJson(fetchFn, url, {});
    out.push(...json.issues);
    startAt += json.issues.length;
    if (!json.issues.length || startAt >= json.total) break;
  }
  return out;
}

const versionRef = (v) => ({ name: v.name, date: v.releaseDate ? Date.parse(v.releaseDate) : null, released: !!v.released });
const shipped = (list) => (list || []).map(versionRef).filter((v) => v.released && v.date != null && RELEASE_NAME.test(v.name)).map(({ name, date }) => ({ name, date }));

export async function fetchJira(fetchFn, cfg, now, windowDays) {
  const p = 'project = ' + cfg.project;
  const days = windowDays + LOOKBACK_DAYS + 30;
  const vers = await getJson(fetchFn, cfg.jira + '/rest/api/2/project/' + cfg.project + '/versions', {});
  const versions = vers.json.map(versionRef).filter((v) => v.released && v.date != null).map(({ name, date }) => ({ name, date }));
  const tickets = (await jiraSearch(fetchFn, cfg, `${p} AND resolutiondate >= -${days}d AND fixVersion is not EMPTY`, 'fixVersions'))
    .map((i) => ({ key: i.key, fix: shipped(i.fields.fixVersions) })).filter((t) => t.fix.length);
  const bugs = (await jiraSearch(fetchFn, cfg, `${p} AND issuetype = Bug AND priority in (Blocker, Critical) AND affectedVersion is not EMPTY AND created >= -${windowDays + 60}d`, 'created,versions,fixVersions,priority'))
    .map((i) => ({ key: i.key, created: ms(i.fields.created), affects: (i.fields.versions || []).map((v) => v.name), fix: shipped(i.fields.fixVersions) }));
  return { versions, tickets, bugs };
}

// Merged pull requests to the main branch, newest activity first, until the list reaches back far enough.
export async function fetchPulls(fetchFn, cfg, token, now, windowDays, { maxPages = 120, log = () => {} } = {}) {
  const headers = { 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const stopAt = now - (windowDays + LOOKBACK_DAYS) * DAY;
  const prs = [];
  let page = 1, reached = false, oldest = now, error = null;
  while (page <= maxPages) {
    const url = `https://api.github.com/repos/${cfg.github}/pulls?` + new URLSearchParams({ state: 'closed', sort: 'updated', direction: 'desc', per_page: '100', page: String(page) });
    let json;
    try { ({ json } = await getJson(fetchFn, url, headers, { log })); } catch (e) { error = e.message; break; }
    if (!Array.isArray(json) || !json.length) { reached = true; break; }
    for (const p of json) {
      oldest = Math.min(oldest, ms(p.updated_at));
      if (!p.merged_at || (p.base && cfg.baseBranch && p.base.ref !== cfg.baseBranch)) continue;
      prs.push({ number: p.number, key: keysIn(p.title, cfg.project)[0] || null, created: ms(p.created_at), merged: ms(p.merged_at) }); // the title goes no further
    }
    log(`page ${page}: ${prs.length} merged so far, back to ${new Date(oldest).toISOString().slice(0, 10)}`);
    if (oldest <= stopAt) { reached = true; break; }
    page++;
  }
  // If the list stopped early (rate limit, page cap), only the part it reached is trusted.
  return { prs, prsFrom: reached ? stopAt : oldest, complete: reached, error, pages: page };
}

export async function fetchRaw(cfg, { fetch: fetchFn = fetch, token = '', now = Date.now(), windowDays = 365, maxPages, log } = {}) {
  const jira = await fetchJira(fetchFn, cfg, now, windowDays);
  const gh = await fetchPulls(fetchFn, cfg, token, now, windowDays, { maxPages, log });
  return { project: cfg.project, ...jira, prs: gh.prs, prsFrom: gh.prsFrom, notes: { complete: gh.complete, error: gh.error, pages: gh.pages } };
}
