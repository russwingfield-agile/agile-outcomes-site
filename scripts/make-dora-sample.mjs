#!/usr/bin/env node
// Writes public/data/dora-sample.json from the simulated project, so the page can be previewed at /demo/dora/?sample=1
// without GitHub access. The page labels it as synthetic. It is not real data about any project.
import { writeFile, mkdir } from 'node:fs/promises';
import { analyse } from '../public/lib/dora.js';
import { simulateRaw } from './lib/dora-sim.mjs';

const now = Date.now();
const report = analyse(simulateRaw(now), now);
report.source = { id: 'sample', title: 'A fictional project', synthetic: true, pullRequestListComplete: true, pullRequestError: null };
await mkdir('public/data', { recursive: true });
await writeFile('public/data/dora-sample.json', JSON.stringify(report) + '\n');
console.log('Wrote public/data/dora-sample.json');
