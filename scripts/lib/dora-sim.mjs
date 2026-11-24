// A fictional project with Kafka-like habits, for tests and for the synthetic preview at /demo/dora/?sample=1.
// None of this is real data. Minor releases come every ~4 months, patch releases between them, and work merged
// just after a release waits a long time for the next one: the pattern the findings are built to notice.
const DAY = 86400000;
function rng(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const logn = (r, med, s) => med * Math.exp(s * Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r()));
const startOfDay = (t) => t - (((t % DAY) + DAY) % DAY);

export function simulateRaw(now, seed = 11, project = 'DEMO') {
  const r = rng(seed), end = startOfDay(now);
  const from = end - (365 + 150 + 60) * DAY;
  // Releases: 3.(n).0 about every 120 days, patch releases about every 40 days.
  const versions = [];
  let minor = 3, t = from + 20 * DAY;
  while (t < end - 3 * DAY) {
    versions.push({ name: `${minor >> 3}.${minor & 7}.0`.replace(/^0\./, '3.'), date: t });
    for (let p = 1, pt = t + (35 + r() * 20) * DAY; pt < t + 110 * DAY && pt < end - 2 * DAY; p++, pt += (30 + r() * 25) * DAY) versions.push({ name: `${minor >> 3}.${minor & 7}.${p}`.replace(/^0\./, '3.'), date: startOfDay(pt) });
    minor++; t += (105 + r() * 30) * DAY; t = startOfDay(t);
  }
  const names = new Set(); versions.forEach((v, i) => { while (names.has(v.name)) v.name += '.1'; names.add(v.name); });
  versions.sort((a, b) => a.date - b.date);
  const nextRelease = (when, preferPatch) => {
    const after = versions.filter((v) => v.date + DAY - 1 >= when);
    if (!after.length) return null;
    const patch = after.find((v) => !/\.0$/.test(v.name));
    return preferPatch && patch && patch.date - when < 60 * DAY ? patch : after.find((v) => /\.0$/.test(v.name)) || after[0];
  };
  const prs = [], tickets = [];
  let n = 1000;
  for (let d = from + 40 * DAY; d < end; d += DAY) {
    const wd = new Date(d).getUTCDay(); if (wd === 0 || wd === 6) continue;
    const count = Math.floor(r() * 7) + 1;
    for (let k = 0; k < count; k++) {
      const merged = d + (9 + r() * 8) * 3600000, opened = merged - logn(r, 2.5, 0.9) * DAY;
      const keyed = r() < 0.66, key = keyed ? `${project}-${++n}` : null;
      prs.push({ number: 20000 + prs.length, key, created: opened, merged });
      if (keyed && r() < 0.9) { const rel = nextRelease(merged, r() < 0.3); if (rel && rel.date <= end) tickets.push({ key, fix: [{ name: rel.name, date: rel.date }] }); }
    }
  }
  const bugs = [];
  versions.forEach((v) => {
    if (r() < 0.3 && v.date + 30 * DAY < end) {
      const c = v.date + (1 + r() * 20) * DAY, fixRel = nextRelease(c + 3 * DAY, true);
      bugs.push({ key: `${project}-${++n}`, created: c, affects: [v.name], fix: fixRel ? [{ name: fixRel.name, date: fixRel.date }] : [] });
    }
  });
  return { project, versions, tickets, prs, bugs, prsFrom: from };
}
