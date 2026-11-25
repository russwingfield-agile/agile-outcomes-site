// Second-layer findings. The charts already show the trends, so these look for what a reader cannot see at a glance:
// how lumpy the output is, what the queue is costing, where work is stuck, whether intake outruns capacity, how far to trust the forecast.
// Each signal is a plain finding (with its numbers) plus one concrete experiment to try. Pure functions; nothing here identifies a person.

const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r0 = (x) => (x == null || !isFinite(x) ? null : Math.round(x));
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

// The waiting status (not the plain working one) that holds the largest share of work in progress, if any holds a lot.
export function bottleneck(ages) {
  const n = ages.length, by = {};
  for (const i of ages) if (!/^in progress$/i.test(i.status)) by[i.status] = (by[i.status] || 0) + 1;
  const [status, count] = Object.entries(by).sort((a, b) => b[1] - a[1])[0] || [null, 0];
  return n >= 5 && count >= 5 && (count / n) * 100 >= 40 ? { status, count, share: r0((count / n) * 100) } : null;
}

export function insightSignals(report) {
  const s = {};
  const full = report.throughput.weeks.filter((w) => !w.partial).map((w) => w.count);
  const mean = avg(full), last4 = avg(full.slice(-4));
  const lt = report.leadTime, days = lt.points.map((p) => p[1]);
  const ages = report.age.items;

  // Throughput: batchiness, slow weeks, or steady output.
  if (full.length >= 8 && mean > 0) {
    const total = full.reduce((a, b) => a + b, 0);
    const top3 = full.slice().sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    const top3Share = r0((top3 / total) * 100), slowWeeks = full.filter((c) => c < mean * 0.5).length;
    const prior8 = avg(full.slice(-12, -4)), rise = prior8 > 0 ? r0(((last4 - prior8) / prior8) * 100) : 0;
    if (rise >= 20 && report.throughput.trend && report.throughput.trend.slope < 0) s.throughput = { id: 'recovering', insight: `Output is up ${rise}% over the last four weeks, to ${r1(last4)} a week, but the ${full.length}-week trend still slopes down: this is a recovery inside a longer decline, not yet a new normal.`, experiment: `Find what changed in the last four weeks (a clear-out, fewer interruptions, a release) and whether it can be repeated. Treat ${r1(last4)} a week as unproven until it holds for another four.` };
    else if (top3Share >= 25) s.throughput = { id: 'lumpy-output', insight: `The three busiest weeks produced ${top3Share}% of the last ${full.length} weeks' output, where an even spread would give 12%. Output arrives in bursts, not as a flow.`, experiment: `Look at what made those weeks different (a clear-out, a release, a push) and try a weekly finish day where only in-flight work is touched. Compare the busiest-weeks share after four weeks.` };
    else if (slowWeeks >= 3) s.throughput = { id: 'slow-weeks', insight: `${slowWeeks} of ${full.length} weeks delivered less than half the ${r1(mean)} a week average, so the average hides regular stalls.`, experiment: `List what was happening in each slow week (holidays, release freezes, review queues) and plan around the repeatable ones. Aim for no more than 1 such week in the next 8.` };
    else s.throughput = { id: 'steady-output', insight: `Output is steady, between ${Math.min(...full)} and ${Math.max(...full)} a week, so capacity is not what limits delivery.`, experiment: `Stop pushing for faster finishing and cut what is started instead: the lever is the queue, not the team.` };
  }

  // Lead time: two populations, a long tail, or a predictable service level.
  if (days.length >= 30 && lt.p50) {
    const quick = r0((days.filter((d) => d <= 7).length / days.length) * 100), slow = r0((days.filter((d) => d > 90).length / days.length) * 100);
    const ratio = r1(lt.p95 / lt.p50);
    if (quick >= 15 && slow >= 15) s.leadTime = { id: 'two-populations', insight: `${quick}% of items resolve within a week and ${slow}% take over 90 days. The ${lt.p50} day median describes neither group, so it should not be used as a promise.`, experiment: `Split the board into a quick lane and a planned lane with separate targets, and report the two lead times separately for the next four weeks.` };
    else if (ratio >= 5) s.leadTime = { id: 'long-tail', insight: `The slowest 1 in 20 items takes ${lt.p95} days, ${ratio} times the ${lt.p50} day median. People feel the tail, not the typical item.`, experiment: `Trace the five slowest items from the last month, find the shared wait (approval, hand-off, unclear scope) and set a rule: anything past ${lt.p85} days is split or swarmed.` };
    else s.leadTime = { id: 'predictable', insight: `The 85th percentile of ${lt.p85} days is only ${r1(lt.p85 / lt.p50)} times the ${lt.p50} day median, so delivery times are predictable.`, experiment: `Publish ${lt.p85} days as the service level and treat any item past it as an incident worth a conversation.` };
  }

  // Work in progress: stuck in one status, too much started at once, or ageing.
  if (report.age.count >= 5 && last4 > 0) {
    const n = report.age.count, weeksOfWork = r1(n / last4), cap = Math.max(1, r0(last4 * 1.5));
    const bn = bottleneck(ages), topStatus = bn && bn.status, topN = bn ? bn.count : 0, topShare = bn ? bn.share : 0;
    const quiet = ages.filter((i) => i.idle != null && i.idle >= 30).length, quietShare = r0((quiet / n) * 100);
    const over = ages.filter((i) => lt.p85 != null && i.age > lt.p85).length, overShare = r0((over / n) * 100);
    const totalAge = ages.reduce((a, i) => a + i.age, 0), tenth = Math.max(1, Math.ceil(n / 10));
    const oldestShare = totalAge ? r0((ages.slice(0, tenth).reduce((a, i) => a + i.age, 0) / totalAge) * 100) : 0;
    if (bn) s.workInProgress = { id: 'stuck-in-status', insight: `${topShare}% of work in progress (${topN} of ${n} items) sits in one waiting status, "${topStatus}". Work is queueing there, not flowing through it.`, experiment: `Set a pull rule for that stage: nothing new enters it until an item leaves. Review what ${topStatus} is waiting on and check the count after two weeks.` };
    else if (quiet >= 5 && quietShare >= 25) s.workInProgress = { id: 'parked-work', insight: `${quiet} of ${n} items in progress (${quietShare}%) have had no update for 30 days or more. They are parked, not in progress, and they inflate both work in progress and lead time.`, experiment: `Move each parked item back to the queue or close it, then re-measure work in progress and median lead time after two weeks.` };
    else if (weeksOfWork >= 2.5) s.workInProgress = { id: 'too-much-started', insight: `${n} items are in progress, which is ${weeksOfWork} weeks of output at the recent rate of ${r1(last4)} a week. Every new item waits behind all of them, so the queue sets lead time.`, experiment: `Cap work in progress at ${cap} for four weeks. Start nothing new above the cap, and compare median lead time at the end.` };
    else s.workInProgress = { id: 'ageing-debt', insight: `The oldest ${tenth} ${tenth === 1 ? 'item holds' : 'items hold'} ${oldestShare}% of all the time work in progress has been open, and ${overShare}% of items are older than the typical ${lt.p85} day finish.`, experiment: `Take the ${tenth} oldest items and decide this week: finish, split or close. Make "oldest first" the standing pull rule.` };
  }

  // Cumulative flow: is the queue structurally outgrowing capacity, and how much raised work is never touched?
  if (report.cfd) {
    const d = report.cfd.days, last = d[d.length - 1], raised = report.cfd.raised;
    const untouched = raised ? r0((last.todo / raised) * 100) : 0;
    const weeksSpan = d.length / 7, fl = report.flow && report.flow.days && report.flow.days.length ? report.flow.days[report.flow.days.length - 1] : null;
    // Finished work counts everything resolved in the period, including older items cleared, so the rate matches the throughput chart.
    const perWeekRaised = r1(raised / weeksSpan), perWeekDone = r1((fl ? Math.max(fl.departed, last.done) : last.done) / weeksSpan);
    if (untouched >= 40) s.cumulativeFlow = { id: 'untouched-queue', insight: `${untouched}% of the ${raised} items raised in the period have never been started. Raising ${perWeekRaised} a week against finishing ${perWeekDone} means the queue is a holding pen, not a plan.`, experiment: `Add a triage rule: every new item gets a decision within a week (do, not now, never) and "not now" items expire after 90 days. Count the untouched share after a month.` };
    else if (last.done && perWeekRaised > perWeekDone * 1.3) s.cumulativeFlow = { id: 'intake-outpaces', insight: `Items are raised at ${perWeekRaised} a week and finished at ${perWeekDone} a week. The gap is structural, so tuning the team will not close it.`, experiment: `Agree an intake limit with the people raising work: one in, one out above a fixed queue size. Review the gap after four weeks.` };
    else s.cumulativeFlow = { id: 'balanced', insight: `Items are raised at ${perWeekRaised} a week and finished at ${perWeekDone} a week, so the queue is in balance.`, experiment: `Use the slack to shrink work in progress and cut lead time rather than taking on more.` };
  }

  // Arrivals vs departures: acceleration of the gap.
  {
    const f = report.flow, L = f.days.length, a = f.days[L - 1], b = f.days[Math.max(0, L - 31)];
    const net30 = (a.arrived - b.arrived) - (a.departed - b.departed);
    const wk26 = r1(f.netChange / (L / 7)), wk30 = r1(net30 / (30 / 7));
    const ratio = a.departed ? r1(a.arrived / a.departed) : null;
    if (ratio != null) {
      if (f.netChange > 0 && wk30 > wk26 * 1.25) s.flow = { id: 'gap-widening', insight: `Open work is growing by ${wk30} a week now, against ${wk26} a week across the period. ${ratio} items arrive for every one resolved, and the gap is speeding up.`, experiment: `Find what changed in the last month (a new source of work, a lost capacity) and agree an intake limit before the gap compounds. Target a net change under ${wk26} a week.` };
      else if (f.netChange > 0) s.flow = { id: 'gap-steady', insight: `${ratio} items arrive for every one resolved, adding about ${wk26} to open work each week. It is a steady drain on the team, not a spike.`, experiment: `Retire old work as deliberately as new work arrives: review the oldest 50 open items and close what will never be done.` };
      else s.flow = { id: 'draining', insight: `More is resolved than raised (${ratio} arrive per item resolved), so open work is shrinking by ${r1(-f.netChange / (L / 7))} a week.`, experiment: `Do not relax intake yet. Hold the current rate for another four weeks and use the room to take on a long-standing item.` };
    }
  }

  // Forecast: how much to trust it, and what to commit to.
  const fc = report.forecast;
  if (fc && fc.calibration.judged >= 4) {
    const j = fc.calibration.judged, h = fc.calibration.atLeast85Held, miss = j - h, c85 = fc.outcomes.atLeast85, c50 = fc.outcomes.atLeast50;
    if (h / j < 0.8) s.forecast = { id: 'overconfident', insight: `Past forecasts missed their own 85% level ${miss} times in ${j}, so output is less stable than the model assumes. The median of ${c50} items is a coin flip.`, experiment: `Commit to ${fc.outcomes.atLeast95} items, the 95% level, until the misses stop. Re-forecast every Monday and log each miss with its reason.` };
    else s.forecast = { id: 'reliable', insight: `Past forecasts held at their 85% level ${h} times in ${j}. The ${c50} item median would be missed about half the time, and ${c85} is the number that has actually been safe.`, experiment: `Commit to ${c85} items for the next four weeks and treat anything above as upside. Re-forecast every Monday.` };
  }

  // Where the page lists specific items under a chart, the experiment starts there.
  const ev = report.evidence || {};
  for (const k of Object.keys(s)) if (ev[k] && ev[k].items && ev[k].items.length && s[k].experiment) s[k].experiment += ' Start with the items listed below.';

  // Pipeline: where open work queues, and whether the recorded workflow matches how work really moves.
  if (report.pipeline) {
    const p = report.pipeline, by = (l) => (p.passedThrough.find((x) => x.label === l) || {}).percent;
    const worked = r0(by('Worked on')), reviewed = r0(by('Code reviewed')), blocked = r1(by('Blocked at any point'));
    const top = p.stages.slice().sort((a, b) => b.count - a.count)[0], topShare = r0(top.percent);
    if (reviewed != null && worked != null && reviewed >= worked + 10) s.pipeline = { id: 'status-skipping', insight: `${reviewed}% of resolved items passed through code review, but only ${worked}% were ever marked in progress. Work is happening before the tracker shows it, so lead time and work in progress both read low.`, experiment: `Mark an item in progress when the first branch or draft exists, not when review starts. Compare the share marked in progress after four weeks.` };
    else if (!/progress|review/i.test(top.name) && topShare >= 35) s.pipeline = { id: 'waiting-queue', insight: `${topShare}% of open work in the tracked stages (${top.count} items) sits in "${top.name}", a waiting stage. It is the biggest queue in the pipeline.`, experiment: `Set a weekly rule for "${top.name}": every item gets moved on, split or closed within two weeks. Compare the size of that queue after a month.` };
    else if (blocked != null && blocked >= 3) s.pipeline = { id: 'blocked-work', insight: `${blocked}% of resolved items were blocked at some point. Each block is a hand-off waiting on someone else.`, experiment: `List the reasons for the last ten blocks, group them, and fix the most common one at its source. Target half as many in the next quarter.` };
    else s.pipeline = { id: 'flowing', insight: `${reviewed != null ? reviewed : worked}% of resolved items moved through the full pipeline and no single stage dominates the queue.`, experiment: `Hold the pipeline steady and tighten the slowest stage by one day, then re-measure lead time.` };
  }

  // The headline: the most pressing finding, in priority order, plus the two next actions.
  const order = [['flow', 'gap-widening'], ['cumulativeFlow', 'untouched-queue'], ['workInProgress', 'parked-work'], ['pipeline', 'status-skipping'], ['pipeline', 'waiting-queue'], ['workInProgress', 'too-much-started'], ['workInProgress', 'stuck-in-status'], ['forecast', 'overconfident'], ['leadTime', 'two-populations'], ['leadTime', 'long-tail'], ['throughput', 'lumpy-output'], ['cumulativeFlow', 'intake-outpaces'], ['flow', 'gap-steady'], ['workInProgress', 'ageing-debt']];
  const ranked = order.map(([k, id]) => s[k] && s[k].id === id ? { chart: k, ...s[k] } : null).filter(Boolean);
  const pick = ranked[0] || Object.entries(s).map(([k, v]) => ({ chart: k, ...v }))[0];
  if (pick) {
    s.overall = { id: pick.id, insight: pick.insight, experiment: pick.experiment };
    s.nextActions = (ranked.length ? ranked : Object.entries(s).filter(([k]) => k !== 'overall').map(([k, v]) => ({ chart: k, ...v }))).slice(0, 2).map((x) => x.experiment);
  }
  return s;
}
