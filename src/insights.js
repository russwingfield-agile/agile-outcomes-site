// Turns the computed numbers into short written commentary using Workers AI.
// Only summary numbers are sent (see insightFacts in metrics.js). The reply is checked before it is used:
// it must be well-formed, must not name the data source, and every number in it must come from the supplied facts.

export const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const KEYS = ['overall', 'throughput', 'leadTime', 'workInProgress', 'flow', 'forecast', 'summary'];
// With status history there is one more entry, for the cumulative flow chart.
export const HISTORY_KEYS = ['overall', 'throughput', 'leadTime', 'workInProgress', 'cumulativeFlow', 'flow', 'forecast', 'summary'];
const keysFor = (facts) => (facts && facts.cumulativeFlow ? HISTORY_KEYS : KEYS);
const MAX_WORDS = { overall: 90, summary: 60, throughput: 70, leadTime: 70, workInProgress: 70, cumulativeFlow: 80, flow: 70, forecast: 70 };

const SYSTEM = `You write the commentary for a delivery dashboard that a CTO reads each morning and in a weekly meeting.
Voice: neutral, plain-English analyst. No first person, no hype, no jargon beyond the metric names.
Rules you must follow:
- Use only the figures in the JSON the user supplies. Quote them exactly as given. Do not calculate, estimate or invent any number. Do not mention a number that is not in the JSON.
- Describe direction using the supplied "direction" words (rose, fell, broadly flat, improved, worsened). Lead time and age: lower is better.
- Do not explain causes or guess why something happened. Say what the data shows and what it implies for delivery.
- Each chart entry is two or three short sentences: first what the numbers show, then one concrete suggestion for where delivery could improve.
- "workInProgress" covers items in progress now and how that count and the median age moved ("overTime" figures, if present). "cumulativeFlow", if present, reads the cumulative flow chart: bands for not started, in progress and done. A widening in progress band means work is starting faster than it finishes; a widening not started band means a growing queue.
- "overall" is three or four sentences for the top of the page: the headline picture across throughput, lead time, work in progress, flow and forecast.
- "summary" is one or two sentences naming the one or two things to focus on next.
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
      obj = parseReply(await env.AI.run(model, { messages: buildMessages(facts, feedback), max_tokens: 900, temperature: 0.2 }));
    } catch (e) { return null; } // the model or its daily allowance is unavailable: keep what we had
    const v = validate(obj, facts);
    if (v.ok) { const text = {}; for (const k of keysFor(facts)) text[k] = obj[k].trim(); return { text, model }; }
    feedback = 'Your previous reply was rejected: ' + v.problems.join('; ') + '. Write it again using only the supplied figures, keeping each entry short.';
  }
  return null;
}
