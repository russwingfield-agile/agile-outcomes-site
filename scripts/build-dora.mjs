#!/usr/bin/env node
// Builds the data file behind /demo/dora/ from public Jira and GitHub data.
//
//   GITHUB_TOKEN=ghp_xxx node scripts/build-dora.mjs                 writes public/data/dora-kafka.json
//   node scripts/build-dora.mjs --probe                              fetch and print what was found, write nothing
//   node scripts/build-dora.mjs --window 270 --max-pages 60          a lighter run
//
// GITHUB_TOKEN is optional but needed in practice: without one GitHub allows 60 requests an hour and a year of
// pull requests is about 70 pages. A token with no scopes (public data only) is enough.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchRaw } from './lib/dora-fetch.mjs';
import { analyse } from '../public/lib/dora.js';
import { SOURCES } from './dora-sources.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i < 0 ? dflt : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
const id = arg('source', 'kafka'), cfg = SOURCES[id];
if (!cfg) { console.error('Unknown source "' + id + '". Known: ' + Object.keys(SOURCES).join(', ')); process.exit(2); }
const windowDays = Number(arg('window', 365)), maxPages = Number(arg('max-pages', 120));
const token = process.env.GITHUB_TOKEN || '', probe = arg('probe', false) === true;
const out = arg('out', `public/data/dora-${id}.json`);
if (!token) console.error('Note: GITHUB_TOKEN is not set. GitHub will allow only 60 requests an hour.');

const now = Date.now();
let raw;
try { raw = await fetchRaw(cfg, { token, now, windowDays, maxPages, log: (m) => console.error('  ' + m) }); } catch (e) {
  const why = (e.cause && (e.cause.code || e.cause.message)) || e.message;
  console.error('Could not fetch the data: ' + e.message + (why !== e.message ? ' (' + why + ')' : '') + '\nNothing was written. Check the network, and that ' + cfg.jira + ' and api.github.com are reachable.');
  process.exit(1);
}
console.error(`Jira: ${raw.versions.length} released versions, ${raw.tickets.length} shipped tickets, ${raw.bugs.length} serious bugs. GitHub: ${raw.prs.length} merged pull requests over ${raw.notes.pages} pages${raw.notes.complete ? '' : ' (stopped early: ' + (raw.notes.error || 'page cap') + ')'}.`);
const report = analyse(raw, now, { windowDays });
report.source = { id, title: cfg.title, jiraBrowse: cfg.jiraBrowse, jiraUrl: cfg.jiraUrl, githubUrl: cfg.githubUrl, pullRequestListComplete: raw.notes.complete, pullRequestError: raw.notes.error || null };
if (probe) {
  console.log(JSON.stringify({ linkage: report.linkage, cadence: { ...report.cadence, gaps: undefined }, lead: { ...report.lead, byRelease: report.lead.byRelease.length + ' releases' }, failure: { ...report.failure, perRelease: undefined }, restore: { ...report.restore, items: report.restore.items.slice(0, 3) }, findings: Object.fromEntries(Object.entries(report.findings).map(([k, v]) => [k, v.id])) }, null, 2));
  console.log('Sample records:', JSON.stringify({ version: raw.versions[0], ticket: raw.tickets[0], pr: raw.prs[0], bug: raw.bugs[0] }));
} else {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report) + '\n');
  console.error('Wrote ' + out);
}
