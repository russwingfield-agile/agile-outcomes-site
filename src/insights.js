// Turns the computed numbers into short written commentary using Workers AI.
// Only summary numbers are sent (see insightFacts in metrics.js). The reply is checked before it is used:
// it must be well-formed, must not name the data source, and every number in it must come from the supplied facts.

export const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'; // a bigger model for sharper reasoning; set INSIGHT_MODEL to override
export const INSIGHT_VERSION = 2;
export const KEYS = ['overall', 'throughput', 'leadTime', 'workInProgress', 'flow', 'forecast', 'summary'];
// With status history there is one more entry, for the cumulative flow chart.
export const HISTORY_KEYS = ['overall', 'throughput', 'leadTime', 'workInProgress', 'cumulativeFlow', 'flow', 'forecast', 'summary'];
const keysFor = (facts) => { const base = facts && facts.cumulativeFlow ? HISTORY_KEYS : KEYS; return facts && facts.pipeline ? base.flatMap((k) => (k === 'workInProgress' ? [k, 'pipeline'] : [k])) : base; };
const MAX_WORDS = { overall: 70, summary: 50, throughput: 62, leadTime: 62, workInProgress: 62, cumulativeFlow: 62, flow: 62, forecast: 62 };

const SYSTEM = `You write the commentary for a delivery dashboard that a CTO reads each morning and in a weekly meeting. They can already read the charts, so never repeat what a chart plainly shows (a line going up, a number being high). Say what the chart does not show, and what to try.
Voice: confident, direct, plain English. Short sentences. Active verbs. No first person, no hype, no filler, no hedging, no jargon beyond the metric names.
Each chart entry has two or three sentences:
1. The insight: the non-obvious reading, in your own words, with the key figure in it.
2. The experiment: one concrete thing the team can try, as a command, with the measure that will show whether it worked ("compare median lead time after four weeks").
The user message gives a "signals" object. For every key that has an entry in signals, build that entry from it: put the signal's insight across in fresh words, then give its experiment as the next action, keeping its figures and its timescale. Do not swap the experiment for generic advice. For keys without a signal, use the other figures and the same two-part shape.
Rules you must follow:
- Use only the figures in the JSON. Quote them exactly as given. Do not calculate, estimate or invent any number.
- Do not use these phrases or ideas: "focus on", "consider", "continue to", "keep an eye", "monitor", "maintain", "it is important", "ensure". Say what to do, concretely.
- Do not explain causes that the figures do not support. A finding can point at a pattern; the experiment is how the team finds the cause.
- Be honest: good news is stated as good, bad news as bad. Do not soften a problem.
- "overall" is the headline for the top of the page: the single most important finding in two or three sentences, ending with what to try first.
- "summary" is two sentences giving the two experiments to run next (signals.nextActions), each starting with a verb.
- Never mention any company, product, tracker or data source name.
Reply with one JSON object only, with exactly the string keys listed by the user message.`;

export function buildMessages(facts, feedback) {
  const user = 'Keys: ' + keysFor(facts).join(', ') + '\nDashboard figures (JSON):\n' + JSON.stringify(facts) + (feedback ? '\n\n' + feedback : '');
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
}

// Every number that appears anywhere in the facts, plus the few small constants the text may legitimately use.
function allowedNumbers(facts) {
  const out = [];
  (function walk(v) {
    if (typeof v === 'number') out.push(v);
    else if (typeof v === 'string') out.push(...numbersIn(v));
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(facts);
  return out.concat([1, 2, 3, 4, 5, 8, 12, 15, 26, 50, 85, 95]);
}
const numbersIn = (text) => (text.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((t) => parseFloat(t.replace(/,/g, '')));

export function validate(obj, facts) {
  const problems = [];
  if (!obj || typeof obj !== 'object') return { ok: false, problems: ['not an object'] };
  const allowed = allowedNumbers(facts);
  const matches = (x) => allowed.some((v) => Math.abs(Math.abs(v) - x) <= Math.max(0.051, 0.002 * Math.abs(v)) || Math.round(Math.abs(v)) === x);
  const bad = new Set();
  for (const k of keysFor(facts)) {
    const t = obj[k];
    if (typeof t !== 'string' || t.trim().length < 20) { problems.push('missing or too short: ' + k); continue; }
    if (t.trim().split(/\s+/).length > MAX_WORDS[k]) problems.push('too long: ' + k);
    if (/atlassian|jira|jracloud|confluence|bitbucket/i.test(t)) problems.push('names a source: ' + k);
    if (/focus on|consider|continue to|keep an eye|monitor|maintain|it is important|ensure/i.test(t)) problems.push('uses a generic phrase: ' + k);
    for (const x of numbersIn(t)) if (!matches(x)) bad.add(x);
  }
  if (bad.size) problems.push('numbers not in the data: ' + [...bad].join(', '));
  return { ok: !problems.length, problems };
}

export function parseReply(reply) {
  const raw = reply && (typeof reply.response === 'string' ? reply.response : reply.response && typeof reply.response === 'object' ? reply.response : null);
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch (e) { return null; }
}

// Returns { text, model } or null. Two attempts at most: the second tells the model what was wrong with the first.
export async function generateInsights(env, facts) {
  if (!env || !env.AI) return null;
  const model = env.INSIGHT_MODEL || DEFAULT_MODEL;
  let feedback = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let obj = null;
    try {
      obj = parseReply(await env.AI.run(model, { messages: buildMessages(facts, feedback), max_tokens: 1100, temperature: 0.2 }));
    } catch (e) { return null; } // the model or its daily allowance is unavailable: keep what we had
    const v = validate(obj, facts);
    if (v.ok) { const text = {}; for (const k of keysFor(facts)) text[k] = obj[k].trim(); return { text, model }; }
    feedback = 'Your previous reply was rejected: ' + v.problems.join('; ') + '. Write it again using only the supplied figures, keeping each entry short.';
  }
  return null;
}

// The findings from signals.js as ready-to-show commentary, used whenever the model has produced nothing usable.
export function signalTexts(facts) {
  const sg = facts && facts.signals;
  if (!sg) return null;
  const out = {};
  for (const k of keysFor(facts)) {
    if (k === 'summary') { if (sg.nextActions && sg.nextActions.length) out.summary = sg.nextActions.join(' '); }
    else if (sg[k]) out[k] = sg[k].insight + ' ' + sg[k].experiment;
  }
  return Object.keys(out).length ? out : null;
}
