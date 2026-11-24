// Example exports for the "Your data" tab. A fictional team is simulated, then written out in the shape of a
// Jira Cloud export or a Linear export. Dates are relative to the moment you ask, so the example never goes stale.
// The simulated team has the patterns the findings look for: output that arrives in bursts at sprint end,
// a review stage that has been getting slower, a queue of untouched items and a few parked ones.

const DAY = 86400000, HOUR = 3600000;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ['Add', 'Fix', 'Update', 'Remove', 'Improve', 'Investigate', 'Refactor', 'Document', 'Migrate', 'Speed up'];
const THINGS = ['retry logic for the webhook', 'the invoice export', 'checkout totals rounding', 'login redirect', 'search filters', 'the audit log page', 'email templates', 'rate limiting', 'the onboarding checklist', 'the settings screen', 'currency conversion', 'report scheduling', 'the mobile menu', 'session timeout', 'bulk import', 'the health check endpoint', 'notification preferences', 'the refund flow', 'cache invalidation', 'the admin dashboard'];
const PEOPLE = ['Alex Morgan', 'Sam Rivera', 'Jordan Lee', 'Casey Patel', 'Riley Chen', 'Taylor Brooks'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A log-normal duration in days: median and spread.
const lognormal = (rnd, median, sigma) => {
  const u = Math.max(1e-9, rnd()), v = rnd();
  return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
};
const workHour = (rnd) => 9 * HOUR + Math.floor(rnd() * 8 * 60) * 60000;
const startOfDay = (t) => t - (((t % DAY) + DAY) % DAY);

export function simulate(now = Date.now(), seed = 7) {
  const rnd = mulberry32(seed);
  const weeks = 40, first = startOfDay(now) - weeks * 7 * DAY;
  // Sprint ends: every second Thursday, counting back from the most recent Thursday.
  const dow = (d) => new Date(d).getUTCDay();
  let lastThu = startOfDay(now); while (dow(lastThu) !== 4) lastThu -= DAY;
  const sprintEnds = []; for (let t = lastThu; t > first; t -= 14 * DAY) sprintEnds.unshift(t + 16 * HOUR);
  const nextSprintEnd = (t) => sprintEnds.find((e) => e > t) || null;

  const items = [];
  for (let day = first; day < startOfDay(now); day += DAY) {
    const wd = dow(day); if (wd === 0 || wd === 6) continue;
    const n = rnd() < 0.12 ? 0 : rnd() < 0.45 ? 1 : rnd() < 0.7 ? 2 : rnd() < 0.85 ? 3 : 4;
    for (let k = 0; k < n; k++) {
      const created = day + workHour(rnd);
      if (created > now) continue;
      const progress = (created - first) / (now - first); // review gets slower the more recent the item
      const r = rnd();
      const it = { created, type: r < 0.5 ? 'Story' : r < 0.82 ? 'Bug' : 'Task', person: PEOPLE[Math.floor(rnd() * PEOPLE.length)], reporter: PEOPLE[Math.floor(rnd() * PEOPLE.length)], title: VERBS[Math.floor(rnd() * VERBS.length)] + ' ' + THINGS[Math.floor(rnd() * THINGS.length)], priority: ['Low', 'Medium', 'Medium', 'High', 'Highest'][Math.floor(rnd() * 5)] };
      const fate = rnd();
      const icebox = fate < 0.14;                    // raised, then never picked up
      const closedWithout = fate >= 0.14 && fate < 0.2; // won't do, or a duplicate
      if (closedWithout) { it.closed = created + (0.5 + rnd() * 20) * DAY; it.resolution = rnd() < 0.5 ? "Won't Do" : 'Duplicate'; }
      else if (!icebox) {
        it.start = created + lognormal(rnd, 5, 1.0) * DAY;
        const dev = lognormal(rnd, 2.6, 0.7), rev = lognormal(rnd, 1.5 + 6 * progress * progress, 0.6);
        it.review = it.start + dev * DAY;
        let done = it.review + rev * DAY;
        const e = nextSprintEnd(done);
        if (e && e - done < 6 * DAY && rnd() < 0.55) done = e + Math.floor(rnd() * 3) * HOUR; // batched into the sprint end
        it.done = done;
      }
      items.push(it);
    }
  }
  // A handful of items started a long time ago and then left alone.
  for (let i = 0; i < 4; i++) {
    const c = now - (90 + rnd() * 70) * DAY;
    items.push({ created: c, type: 'Story', person: PEOPLE[i % PEOPLE.length], reporter: PEOPLE[(i + 2) % PEOPLE.length], title: VERBS[i] + ' ' + THINGS[i + 6], priority: 'Medium', start: c + 6 * DAY, review: Infinity, done: Infinity, parked: true });
  }
  items.sort((a, b) => a.created - b.created);
  items.forEach((it, i) => {
    it.n = 1001 + i;
    const d = it.done, st = it.start, rv = it.review;
    if (it.closed != null && it.closed <= now) { it.status = 'Done'; it.finished = it.closed; it.updated = it.closed; }
    else if (it.closed != null) { it.status = 'Backlog'; it.updated = it.created; delete it.resolution; }
    else if (d != null && d <= now) { it.status = 'Done'; it.finished = d; it.updated = d + (rnd() < 0.3 ? rnd() * 2 * DAY : 0); if (it.updated > now) it.updated = now; }
    else if (rv != null && rv <= now && !it.parked) { it.status = 'In Review'; it.updated = Math.min(now, rv + rnd() * (now - rv)); }
    else if (st != null && st <= now) { it.status = 'In Progress'; it.updated = it.parked ? st + 2 * DAY : Math.min(now, st + rnd() * (now - st)); }
    else { it.status = st != null && st - now < 10 * DAY ? 'Selected for Development' : 'Backlog'; it.updated = it.created + (rnd() < 0.5 ? 0 : rnd() * Math.min(20, (now - it.created) / DAY) * DAY); }
    if (it.status === 'Backlog' || it.status === 'Selected for Development') delete it.start;
    if (it.status === 'In Progress' || it.status === 'In Review' || it.status === 'Done') { /* start stays */ }
  });
  return items;
}

const pad = (n) => String(n).padStart(2, '0');
const jiraDate = (t) => { const d = new Date(t), h = d.getUTCHours(); return `${d.getUTCDate()}/${MONTHS[d.getUTCMonth()]}/${pad(d.getUTCFullYear() % 100)} ${h % 12 || 12}:${pad(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`; };
const isoDate = (t) => new Date(t).toISOString();
const q = (v) => { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const line = (cells) => cells.map(q).join(',');
const category = (s) => (s === 'Done' ? 'Done' : s === 'In Progress' || s === 'In Review' ? 'In Progress' : 'To Do');

function description(it) {
  return it.type === 'Bug'
    ? `Steps to reproduce:\n1. Open ${it.title.toLowerCase()}\n2. Repeat twice in a row\n\nExpected: no error.\nActual: the second attempt fails.`
    : `As a customer I want ${it.title.toLowerCase()}\nso that it is quicker to get things done.\n\nAcceptance criteria:\n- Works on desktop and mobile\n- Covered by a test`;
}

// A Jira Cloud style export: duplicate Labels and Sprint columns, quoted multi-line descriptions, dates like 13/Mar/26 9:41 AM.
export function jiraCsv(now = Date.now(), seed = 7) {
  const items = simulate(now, seed);
  const head = ['Summary', 'Issue key', 'Issue id', 'Issue Type', 'Status', 'Project key', 'Project name', 'Priority', 'Resolution', 'Assignee', 'Reporter', 'Created', 'Updated', 'Resolved', 'Labels', 'Labels', 'Sprint', 'Sprint', 'Status Category', 'Status Category Changed', 'Description'];
  const sprintOf = (t) => 'Sprint ' + (20 + Math.floor((t - (now - 40 * 7 * DAY)) / (14 * DAY)));
  const out = [line(head)];
  for (const it of items) {
    const done = it.status === 'Done';
    const catChanged = done ? it.finished : it.status === 'In Progress' || it.status === 'In Review' ? it.start : it.created;
    out.push(line([
      it.title, 'PAY-' + it.n, 10000 + it.n, it.type, it.status, 'PAY', 'Payments', it.priority,
      done ? it.resolution || 'Done' : '', done || it.status !== 'Backlog' ? it.person : '', it.reporter,
      jiraDate(it.created), jiraDate(it.updated), done ? jiraDate(it.finished) : '',
      it.type === 'Bug' ? 'regression' : '', it.priority === 'Highest' ? 'customer' : '',
      done && it.finished ? sprintOf(it.finished) : it.status === 'Backlog' ? '' : sprintOf(now), '',
      category(it.status), jiraDate(catChanged), description(it),
    ]));
  }
  return out.join('\n') + '\n';
}

// A Linear style export: ISO dates and a Started column, so the status history charts can be drawn.
export function linearCsv(now = Date.now(), seed = 7) {
  const items = simulate(now, seed);
  const head = ['ID', 'Team', 'Title', 'Description', 'Status', 'Priority', 'Project', 'Created', 'Updated', 'Started', 'Completed', 'Canceled'];
  const out = [line(head)];
  for (const it of items) {
    const done = it.status === 'Done', cancelled = done && it.resolution;
    const status = cancelled ? (it.resolution === 'Duplicate' ? 'Duplicate' : 'Canceled') : it.status === 'Backlog' ? 'Backlog' : it.status === 'Selected for Development' ? 'Todo' : it.status;
    out.push(line([
      'PAY-' + it.n, 'Payments', it.title, description(it), status, it.priority === 'Highest' ? 'Urgent' : it.priority,
      'Checkout', isoDate(it.created), isoDate(it.updated), it.start && !cancelled && (it.status === 'In Progress' || it.status === 'In Review' || done) ? isoDate(it.start) : '',
      done && !cancelled ? isoDate(it.finished) : '', cancelled ? isoDate(it.finished) : '',
    ]));
  }
  return out.join('\n') + '\n';
}
