import assert from 'node:assert/strict';
import { analyse, keysIn, percentile, RELEASE_NAME, DAY } from '../public/lib/dora.js';
import { fetchRaw } from '../scripts/lib/dora-fetch.mjs';
import { simulateRaw } from '../scripts/lib/dora-sim.mjs';

const now = Date.parse('2026-11-24T12:00:00Z');
const d = (s) => Date.parse(s);

// --- keys and release names
assert.deepEqual(keysIn('KAFKA-123: Fix the thing (#456)', 'KAFKA'), ['KAFKA-123']);
assert.deepEqual(keysIn('[KAFKA-1][KAFKA-2] two, KAFKA-1 again', 'KAFKA'), ['KAFKA-1', 'KAFKA-2']);
assert.deepEqual(keysIn('MINOR: tidy up', 'KAFKA'), []);
assert.deepEqual(keysIn('XKAFKA-5 and KAFKA-12abc', 'KAFKA'), []);
assert.ok(RELEASE_NAME.test('3.7.0') && RELEASE_NAME.test('0.11.0.0') && !RELEASE_NAME.test('3.7.0-rc1') && !RELEASE_NAME.test('trunk'));
assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
console.log('keys ok');

// --- a hand-built case with known answers
{
  const raw = {
    project: 'T',
    versions: [{ name: '1.0.0', date: d('2026-01-10') }, { name: '1.1.0', date: d('2026-03-10') }, { name: '1.1.1', date: d('2026-04-09') }, { name: '1.2.0', date: d('2026-07-10') }, { name: '1.2.1', date: d('2026-08-09') }, { name: '2.0.0-rc1', date: d('2026-09-01') }],
    // ten changes, each open 4 days and then merged on 2026-03-01, shipped in 1.1.0 on 2026-03-10 (waits ~9.99 days)
    tickets: Array.from({ length: 10 }, (_, i) => ({ key: 'T-' + i, fix: [{ name: '1.1.0', date: d('2026-03-10') }] })),
    prs: Array.from({ length: 10 }, (_, i) => ({ number: i, key: 'T-' + i, created: d('2026-02-25T00:00:00Z'), merged: d('2026-03-01T00:00:00Z') })).concat([{ number: 99, key: null, created: d('2026-03-01'), merged: d('2026-03-02') }]),
    bugs: [
      { key: 'T-100', created: d('2026-03-15'), affects: ['1.1.0'], fix: [{ name: '1.1.1', date: d('2026-04-09') }] },   // 1.1.0 fails, fixed 25 days later (to the end of the release day)
      { key: 'T-101', created: d('2026-07-20'), affects: ['1.2.0'], fix: [] },                                          // 1.2.0 fails, not yet shipped
      { key: 'T-102', created: d('2026-06-01'), affects: ['1.1.0'], fix: [] },                                          // too late to count against 1.1.0
    ],
    prsFrom: d('2025-01-01'),
  };
  const r = analyse(raw, now, { windowDays: 365 });
  assert.equal(r.cadence.releases, 5); // the rc is not a release
  assert.equal(r.cadence.perMonth, 0.4);
  assert.equal(r.cadence.gaps[1].gap, 59); // 10 Jan to 10 Mar
  assert.equal(r.lead.changes, 10);
  assert.equal(r.lead.reviewP50, 4);
  assert.ok(Math.abs(r.lead.waitP50 - 9.99) < 0.01, 'merged at midnight on 1 March, released on 10 March, counted to the end of release day');
  assert.equal(r.lead.waitShare, 71);
  assert.equal(r.lead.byRelease.find((x) => x.name === '1.1.0').n, 10);
  assert.equal(r.linkage.mergedPullRequests, 11);
  assert.equal(r.linkage.withTicketKey, 10);
  assert.equal(r.linkage.withTicketKeyPercent, 91);
  // failures: judged = releases at least 30 days old; 1.1.0 and 1.2.0 failed
  assert.equal(r.failure.judged, 5);
  assert.equal(r.failure.failed, 2);
  assert.equal(r.failure.rate, 40);
  assert.deepEqual(r.failure.perRelease.find((x) => x.name === '1.1.0').keys, ['T-100']);
  assert.equal(r.restore.fixed, 1);
  assert.equal(r.restore.notYetShipped, 1);
  assert.ok(r.findings.leadTime.id === 'balanced' || r.findings.leadTime.id === 'waiting-for-release');
  assert.equal(r.findings.failure.id, 'frequent');
  // privacy: nothing but ids, names and dates
  assert.ok(!('title' in r) && !JSON.stringify(r).includes('Fix'));
  console.log('hand-built ok');
}

// --- not enough linked work: lead time is withheld, not guessed
{
  const raw = { project: 'T', versions: [{ name: '1.0.0', date: d('2026-06-01') }], tickets: [], prs: [{ number: 1, key: 'T-1', created: d('2026-05-01'), merged: d('2026-05-02') }], bugs: [], prsFrom: d('2025-01-01') };
  const r = analyse(raw, now);
  assert.equal(r.lead.reported, false);
  assert.equal(r.lead.p50, null);
  assert.equal(r.findings.leadTime.id, 'not-enough');
  assert.equal(r.linkage.ticketNotFound, 1);
  console.log('thin data ok');
}

// --- a pull request list that starts late hides the early releases rather than understating their wait
{
  const raw = simulateRaw(now);
  const full = analyse(raw, now);
  const short = analyse({ ...raw, prsFrom: now - 200 * DAY }, now);
  assert.ok(Date.parse(short.leadFrom) > Date.parse(full.leadFrom));
  assert.ok(short.lead.byRelease.length < full.lead.byRelease.length);
  console.log('coverage ok');
}

// --- the simulated project: findings fire and numbers are sane
{
  const r = analyse(simulateRaw(now), now);
  assert.ok(r.cadence.releases >= 6 && r.cadence.releases <= 14, 'releases ' + r.cadence.releases);
  assert.ok(r.lead.reported && r.lead.waitP50 > r.lead.reviewP50, 'merged work waits longer than it is reviewed: ' + JSON.stringify([r.lead.reviewP50, r.lead.waitP50]));
  assert.equal(r.findings.leadTime.id, 'waiting-for-release');
  assert.ok(r.linkage.withTicketKeyPercent > 55 && r.linkage.withTicketKeyPercent < 75);
  assert.ok(r.findings.overall && r.findings.summary);
  console.log('simulated ok:', JSON.stringify({ rel: r.cadence.releases, lead: r.lead.p50, review: r.lead.reviewP50, wait: r.lead.waitP50, cfr: r.failure.rate, restore: r.restore.p50 }));
}

// --- the fetcher, against fake GitHub and Jira servers that use the real response shapes
{
  const sim = simulateRaw(now, 5, 'KAFKA');
  const iso = (t) => new Date(t).toISOString(), dateOnly = (t) => iso(t).slice(0, 10);
  const verObj = (v, i) => ({ self: 'https://j/rest/api/2/version/' + i, id: String(10000 + i), name: v.name, archived: false, released: true, releaseDate: dateOnly(v.date), projectId: 1 });
  const verIndex = new Map(sim.versions.map((v, i) => [v.name, verObj(v, i)]));
  const verList = (fix) => fix.map((f) => verIndex.get(f.name));
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(url);
    const u = new URL(url), json = (b, status = 200, h = {}) => ({ ok: status < 300, status, headers: { get: (k) => h[k.toLowerCase()] ?? null }, json: async () => b });
    assert.match(init.headers['User-Agent'], /AgileOutcomes/);
    if (u.host === 'issues.apache.org') {
      if (u.pathname.endsWith('/versions')) return json(sim.versions.map(verObj));
      const jql = u.searchParams.get('jql'), start = Number(u.searchParams.get('startAt')), size = 700; // the server caps the page below the 1000 asked for
      const rows = /issuetype = Bug/.test(jql)
        ? sim.bugs.map((b) => ({ id: '1', key: b.key, fields: { created: iso(b.created).replace('Z', '.000+0000'), priority: { name: 'Blocker' }, versions: b.affects.map((n) => verIndex.get(n)), fixVersions: verList(b.fix) } }))
        : sim.tickets.map((t) => ({ id: '1', key: t.key, fields: { fixVersions: verList(t.fix).concat([{ name: 'trunk-unreleased', released: false, id: '9' }]) } }));
      return json({ startAt: start, maxResults: size, total: rows.length, issues: rows.slice(start, start + size) });
    }
    if (u.host === 'api.github.com') {
      assert.equal(init.headers.Authorization, 'Bearer tok');
      const page = Number(u.searchParams.get('page')), per = 100;
      // newest activity first, as the real list is; some PRs are closed without merging and some target other branches
      const all = sim.prs.slice().sort((a, b) => b.merged - a.merged).flatMap((p, i) => {
        const rows = [{ number: p.number, title: p.key ? `${p.key}: Some title (#${p.number})` : 'MINOR: something', state: 'closed', created_at: iso(p.created), updated_at: iso(p.merged), closed_at: iso(p.merged), merged_at: iso(p.merged), base: { ref: i % 17 === 0 ? '3.7' : 'trunk' }, user: { login: 'someone' } }];
        if (i % 5 === 0) rows.push({ number: 90000 + i, title: 'WIP ' + (p.key || ''), state: 'closed', created_at: iso(p.created), updated_at: iso(p.merged), closed_at: iso(p.merged), merged_at: null, base: { ref: 'trunk' } });
        return rows;
      });
      return json(all.slice((page - 1) * per, page * per));
    }
    return json({}, 404);
  };
  const cfg = { github: 'apache/kafka', baseBranch: 'trunk', jira: 'https://issues.apache.org/jira', project: 'KAFKA' };
  const raw = await fetchRaw(cfg, { fetch: fakeFetch, token: 'tok', now, windowDays: 365 });
  assert.ok(raw.notes.complete, 'reached the end of the window: ' + JSON.stringify(raw.notes));
  assert.ok(calls.some((c) => /\/search\?/.test(c) && /startAt=700/.test(c)), 'second Jira page was requested using the size the server returned');
  assert.equal(raw.versions.length, sim.versions.length);
  assert.ok(raw.tickets.every((t) => t.fix.every((f) => !/unreleased/.test(f.name))), 'unreleased fix versions are dropped');
  assert.ok(raw.prs.length > 500 && raw.prs.every((p) => p.merged && p.number < 90000), 'unmerged PRs are dropped');
  assert.ok(raw.prs.filter((p) => p.key).length > 0 && raw.prs.every((p) => !p.key || /^KAFKA-\d+$/.test(p.key)));
  assert.ok(!JSON.stringify(raw).includes('Some title') && !JSON.stringify(raw).includes('someone'), 'no titles or people are kept');
  const r = analyse(raw, now);
  assert.ok(r.lead.reported && r.cadence.releases >= 6);
  console.log('fetcher ok:', calls.length, 'requests;', raw.prs.length, 'merged PRs kept');
}

// --- rate limits and failures are reported, and what was read is still used
{
  let n = 0;
  const ghHeaders = { 'x-ratelimit-remaining': '0' };
  const f = async (url) => {
    const u = new URL(url), json = (b, status = 200, h = {}) => ({ ok: status < 300, status, headers: { get: (k) => h[k.toLowerCase()] ?? null }, json: async () => b });
    if (u.host === 'api.github.com') { n++; return n === 1 ? json([{ number: 1, title: 'KAFKA-1: x', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', merged_at: '2026-11-02T00:00:00Z', base: { ref: 'trunk' } }]) : json({ message: 'rate limit' }, 403, ghHeaders); }
    return u.pathname.endsWith('/versions') ? json([]) : json({ startAt: 0, maxResults: 1000, total: 0, issues: [] });
  };
  const raw = await fetchRaw({ github: 'a/b', baseBranch: 'trunk', jira: 'https://j', project: 'KAFKA' }, { fetch: f, now });
  assert.equal(raw.prs.length, 1);
  assert.equal(raw.notes.complete, false);
  assert.match(raw.notes.error, /rate limit/i);
  assert.ok(raw.prsFrom > now - 30 * DAY, 'coverage only reaches as far back as the pages that were read');
  console.log('rate limit ok');
}
console.log('all dora tests ok');
