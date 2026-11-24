// DORA-style release metrics from linked Jira and GitHub data. Pure functions: no network, no DOM.
// Inputs are plain records (see `analyse`). Nothing about people is read, and titles are never kept:
// a pull request title is only used by the fetcher to find a ticket key, then thrown away.
//
// "Deployment" here means a release: a Jira version marked as released, with its release date. Open-source projects
// publish releases, not production deploys, so the metrics are DORA-style rather than DORA-exact, and the page says so.

export const DAY = 86400000;
export const RELEASE_NAME = /^\d+(\.\d+){1,3}$/;   // 3.7.0, 3.7.1, 0.11.0.0 (not release candidates or placeholders)
export const FAILURE_DAYS = 30;                    // a serious bug raised this soon after a release counts against it
export const LOOKBACK_DAYS = 150;                  // merged work can wait this long for a release, so pull requests are read this far back
const MIN_CHANGES = 8;                             // fewer linked changes than this and lead time is not reported

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r0 = (x) => (x == null ? null : Math.round(x));
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export function percentile(values, p) {
  const a = values.slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

// Ticket keys in a piece of text, in order, without repeats: "KAFKA-123: fix" and "[KAFKA-1][KAFKA-2] x" both work.
export function keysIn(text, project) {
  const re = new RegExp('\\b' + project + '-(\\d+)\\b', 'g'), out = [];
  let m;
  while ((m = re.exec(String(text || '')))) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

// The earliest of these released versions that is on or after the time `t`.
// Release dates have no time of day, so a change merged during a release day is counted in that release.
const firstReleaseAfter = (versions, t) => (versions || []).filter((v) => RELEASE_NAME.test(v.name) && v.date + DAY - 1 >= t).sort((a, b) => a.date - b.date)[0] || null;

/*
raw = {
  project: 'KAFKA',
  versions: [{ name, date }],                       // released versions of the project
  tickets:  [{ key, fix: [{ name, date }] }],       // resolved tickets with released fix versions
  prs:      [{ number, key, created, merged }],     // merged pull requests to the main branch; key is a ticket key or null
  bugs:     [{ key, created, affects: [name], fix: [{ name, date }] }],  // serious bugs (Blocker or Critical) that name an affected version
  prsFrom:  ms,                                     // how far back the pull request list reliably reaches
}
*/
export function analyse(raw, now, { windowDays = 365 } = {}) {
  const windowStart = now - windowDays * DAY;
  const released = raw.versions.filter((v) => RELEASE_NAME.test(v.name) && v.date <= now).sort((a, b) => a.date - b.date);
  const releases = released.filter((v) => v.date >= windowStart);
  const before = released.filter((v) => v.date < windowStart).pop() || null;

  // Cadence: days between one release and the next.
  const gaps = releases.map((r, i) => ({ name: r.name, date: day(r.date), gap: i ? (r.date - releases[i - 1].date) / DAY : before ? (r.date - before.date) / DAY : null }));
  const gapDays = gaps.map((g) => g.gap).filter((g) => g != null);
  const medGap = percentile(gapDays, 0.5);
  const mean = gapDays.length ? gapDays.reduce((a, b) => a + b, 0) / gapDays.length : null;
  const sd = gapDays.length > 1 ? Math.sqrt(gapDays.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gapDays.length) : null;
  const cadence = { releases: releases.length, perMonth: r1(releases.length / (windowDays / 30.44)), medianGapDays: r1(medGap), longestGapDays: gapDays.length ? r0(Math.max(...gapDays)) : null, variation: mean && sd != null ? r1(sd / mean) : null, gaps };

  // Link: pull request -> ticket key -> the release the ticket shipped in.
  const ticket = new Map(raw.tickets.map((t) => [t.key, t]));
  const byKey = new Map();
  for (const p of raw.prs) {
    if (!p.key || p.merged == null || p.merged < windowStart - LOOKBACK_DAYS * DAY) continue;
    const g = byKey.get(p.key) || { key: p.key, opened: p.created, merged: p.merged, prs: 0 };
    g.opened = Math.min(g.opened, p.created); g.merged = Math.max(g.merged, p.merged); g.prs++;
    byKey.set(p.key, g);
  }
  const mergedTotal = raw.prs.filter((p) => p.merged != null && p.merged >= windowStart).length;
  const mergedWithKey = raw.prs.filter((p) => p.key && p.merged != null && p.merged >= windowStart).length;
  const leadFrom = Math.max(windowStart, (raw.prsFrom || 0) + LOOKBACK_DAYS * DAY); // earlier releases would be missing the work merged before the list begins
  const changes = [];
  let noTicket = 0, notShipped = 0;
  for (const g of byKey.values()) {
    const t = ticket.get(g.key);
    if (!t) { noTicket++; continue; }
    const rel = firstReleaseAfter(t.fix, g.merged);
    if (!rel) { notShipped++; continue; }
    if (rel.date < leadFrom || rel.date > now) continue;
    changes.push({ key: g.key, release: rel.name, released: rel.date, review: Math.max(0, (g.merged - g.opened) / DAY), wait: Math.max(0, (rel.date + DAY - 1 - g.merged) / DAY) });
  }
  changes.forEach((c) => { c.lead = c.review + c.wait; });
  const col = (k) => changes.map((c) => c[k]);
  const enough = changes.length >= MIN_CHANGES;
  const lead = {
    changes: changes.length, reported: enough,
    p50: enough ? r1(percentile(col('lead'), 0.5)) : null, p85: enough ? r1(percentile(col('lead'), 0.85)) : null,
    reviewP50: enough ? r1(percentile(col('review'), 0.5)) : null, waitP50: enough ? r1(percentile(col('wait'), 0.5)) : null,
    waitShare: enough ? r0((percentile(col('wait'), 0.5) / Math.max(0.01, percentile(col('review'), 0.5) + percentile(col('wait'), 0.5))) * 100) : null,
    byRelease: releases.filter((r) => r.date >= leadFrom).map((r) => {
      const cs = changes.filter((c) => c.release === r.name);
      return { name: r.name, date: day(r.date), n: cs.length, review: cs.length >= 3 ? r1(percentile(cs.map((c) => c.review), 0.5)) : null, wait: cs.length >= 3 ? r1(percentile(cs.map((c) => c.wait), 0.5)) : null };
    }),
  };

  // Change failure: a serious bug raised within FAILURE_DAYS of a release that it says it affects.
  const judged = releases.filter((r) => r.date + FAILURE_DAYS * DAY <= now);
  const failureBugs = new Map();
  const perRelease = releases.map((r) => {
    const bugs = raw.bugs.filter((b) => b.affects.includes(r.name) && b.created >= r.date && b.created < r.date + (FAILURE_DAYS + 1) * DAY);
    bugs.forEach((b) => failureBugs.set(b.key, b));
    return { name: r.name, date: day(r.date), judged: r.date + FAILURE_DAYS * DAY <= now, bugs: bugs.length, keys: bugs.slice(0, 5).map((b) => b.key) };
  });
  const failed = perRelease.filter((r) => r.judged && r.bugs > 0);
  const failure = { judged: judged.length, failed: failed.length, rate: judged.length ? r0((failed.length / judged.length) * 100) : null, perRelease, window: FAILURE_DAYS };

  // Time to restore: from the serious bug being raised to the release that fixed it.
  const restoreDays = [], unfixed = [];
  for (const b of failureBugs.values()) {
    const fix = firstReleaseAfter(b.fix, b.created);
    if (fix) restoreDays.push({ key: b.key, days: Math.max(0, (fix.date + DAY - 1 - b.created) / DAY), fixedIn: fix.name }); else unfixed.push(b.key);
  }
  const rd = restoreDays.map((x) => x.days);
  const restore = { fixed: restoreDays.length, notYetShipped: unfixed.length, p50: rd.length >= 3 ? r1(percentile(rd, 0.5)) : null, p85: rd.length >= 3 ? r1(percentile(rd, 0.85)) : null, items: restoreDays.sort((a, b) => a.days - b.days).map((x) => ({ key: x.key, days: r1(x.days), fixedIn: x.fixedIn })) };

  const linkage = {
    mergedPullRequests: mergedTotal, withTicketKey: mergedWithKey,
    withTicketKeyPercent: mergedTotal ? r0((mergedWithKey / mergedTotal) * 100) : null,
    changesLinked: changes.length, ticketNotFound: noTicket, mergedNotYetReleased: notShipped,
  };
  const report = {
    generatedAt: new Date(now).toISOString(), project: raw.project, windowDays, from: day(windowStart), to: day(now), leadFrom: day(leadFrom),
    prsFrom: raw.prsFrom ? day(raw.prsFrom) : null, cadence, lead, failure, restore, linkage,
  };
  report.findings = findings(report);
  return report;
}

/* ---------- plain-English findings: an insight and one experiment each ---------- */
export function findings(r) {
  const out = {};
  const c = r.cadence, l = r.lead, f = r.failure, s = r.restore;

  if (c.releases >= 3 && c.medianGapDays != null) {
    if (c.variation != null && c.variation >= 0.9) out.release = { id: 'irregular', insight: `${c.releases} releases in ${r.windowDays} days, but the gaps range from short patch releases to ${c.longestGapDays} days, with a median of ${c.medianGapDays}. The rhythm is mixed, not steady.`, experiment: `Pick a fixed cadence for the next two quarters and release on that day whatever is merged. Compare the longest gap after eight weeks.`, weight: 2 };
    else if (c.medianGapDays >= 45) out.release = { id: 'infrequent', insight: `Releases come a median of ${c.medianGapDays} days apart, so any change merged just after one waits weeks for the next.`, experiment: `Run a small, fixed-day release every two weeks for one quarter and compare the median gap and the merged-to-released wait.`, weight: 3 };
    else out.release = { id: 'regular', insight: `A release every ${c.medianGapDays} days (${c.perMonth} a month), and the longest gap was ${c.longestGapDays} days. Delivery to users is regular.`, experiment: `Keep the cadence and shrink what goes in each release. Track the number of changes per release over the next quarter.`, weight: 0 };
  }
  if (l.reported) {
    if (l.waitP50 > l.reviewP50 * 1.5 && l.waitShare >= 55) out.leadTime = { id: 'waiting-for-release', insight: `A change is open for a median of ${l.reviewP50} days, then waits another ${l.waitP50} days merged and not yet released. ${l.waitShare}% of its journey is waiting for a release, so faster review would barely move the ${l.p50} day median.`, experiment: `Cut the wait, not the review: release smaller and more often, or let finished fixes out between trains. Compare the merged-to-released median after one quarter.`, weight: 5 };
    else if (l.reviewP50 > l.waitP50 * 1.5) out.leadTime = { id: 'slow-review', insight: `A change is open for a median of ${l.reviewP50} days before it merges, against ${l.waitP50} days waiting for a release. Review and rework are where the time goes.`, experiment: `Agree a first-response time for review (one working day) and cap open changes per author. Compare the opened-to-merged median in four weeks.`, weight: 4 };
    else out.leadTime = { id: 'balanced', insight: `The median change takes ${l.p50} days from opening to release: ${l.reviewP50} in review and ${l.waitP50} waiting for a release. The 85th percentile is ${l.p85} days.`, experiment: `Publish ${l.p85} days as the expected worst case for a normal change, and investigate anything beyond it.`, weight: 1 };
  } else out.leadTime = { id: 'not-enough', insight: `Only ${l.changes} releases' worth of pull requests could be linked to a shipped ticket, which is too few to report lead time.`, experiment: `Check how many pull requests carry a ticket key in their title (${r.linkage.withTicketKeyPercent == null ? 'unknown' : r.linkage.withTicketKeyPercent + '%'} here) and make it a merge rule.`, weight: 0 };
  if (f.judged >= 4) {
    if (f.rate >= 30) out.failure = { id: 'frequent', insight: `${f.failed} of ${f.judged} releases (${f.rate}%) were followed by a Blocker or Critical bug within ${f.window} days. That is a high change failure rate.`, experiment: `Take the bugs listed below and trace what each release had in common (size, timing, a skipped check). Add one gate for the commonest cause and compare over the next four releases.`, weight: 5 };
    else if (f.failed > 0) out.failure = { id: 'occasional', insight: `${f.failed} of ${f.judged} releases (${f.rate}%) were followed by a Blocker or Critical bug within ${f.window} days. Most releases hold.`, experiment: `Read the bugs below as a set: if they cluster in one area, add a test or a check there before the next release.`, weight: 2 };
    else out.failure = { id: 'clean', insight: `None of the last ${f.judged} releases was followed by a Blocker or Critical bug within ${f.window} days.`, experiment: `Check that bugs are being given an affected version. A clean record is only as good as the bug data behind it.`, weight: 0 };
  }
  if (s.p50 != null) {
    if (s.p50 >= 21) out.restore = { id: 'slow-restore', insight: `Fixes for those serious bugs reached users a median of ${s.p50} days after the bug was raised, and the slowest took ${s.p85} days (85th percentile). The fix usually exists sooner than it ships.`, experiment: `Allow an out-of-cycle patch release for any Blocker, and measure raised-to-released for the next three.`, weight: 4 };
    else out.restore = { id: 'quick-restore', insight: `Serious bugs were fixed and released a median of ${s.p50} days after being raised (85th percentile ${s.p85}).`, experiment: `Keep the patch route open and watch the 85th percentile: it is the number a customer feels.`, weight: 1 };
  }
  const ranked = Object.entries(out).filter(([, v]) => v.weight >= 2).sort((a, b) => b[1].weight - a[1].weight);
  const top = ranked[0] || Object.entries(out).sort((a, b) => b[1].weight - a[1].weight)[0];
  const texts = {};
  for (const [k, v] of Object.entries(out)) texts[k] = { id: v.id, text: v.insight + ' ' + v.experiment };
  if (top) texts.overall = { id: top[1].id, text: top[1].insight + ' ' + top[1].experiment };
  const actions = ranked.slice(0, 2).map(([, v]) => v.experiment);
  if (actions.length) texts.summary = { id: 'next', text: actions.join(' ') };
  return texts;
}
