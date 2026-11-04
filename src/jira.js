// Small read-only client for the public Jira search API. Anonymous; no people fields are ever requested.
export const JIRA = 'https://jira.atlassian.com';
export const PROJECT = 'JRACLOUD';
const UA = 'AgileOutcomes-showcase/1.0 (+https://agileoutcomes.co.uk)';

export async function jira(params) {
  const res = await fetch(JIRA + '/rest/api/2/search?' + new URLSearchParams(params), { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error('Jira responded ' + res.status);
  return res.json();
}

// Page through a query. The page size the server actually allows is read from its reply.
export async function all(jql, fields, cap = 3000) {
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
export const count = async (jql) => (await jira({ jql, maxResults: '0' })).total;

// Status names grouped by what they mean for the flow chart. Read from the project, not hard-coded.
export async function statusGroups() {
  const res = await fetch(JIRA + '/rest/api/2/project/' + PROJECT + '/statuses', { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error('Jira responded ' + res.status);
  return groupStatuses(await res.json());
}

// untriaged: new work nobody has assessed. backlog: assessed, waiting. active: being worked. done: finished.
export function groupStatuses(projectStatuses) {
  const seen = new Map();
  for (const type of projectStatuses || []) for (const s of type.statuses || []) seen.set(s.name, s.statusCategory && s.statusCategory.key);
  const g = { untriaged: [], backlog: [], active: [], done: [] };
  for (const [name, cat] of seen) {
    if (cat === 'done') g.done.push(name);
    else if (cat === 'indeterminate') g.active.push(name);
    else if (/triage|gathering/i.test(name)) g.untriaged.push(name);
    else g.backlog.push(name);
  }
  return g;
}
export const jqlList = (names) => names.map((n) => '"' + String(n).replace(/"/g, '') + '"').join(', ');
