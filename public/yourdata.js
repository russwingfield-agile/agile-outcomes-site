/* "Your data" tab: reads a CSV export chosen by the visitor and hands the resulting report to showcase.js to draw.
   The file is read with the File API in this browser. Nothing here makes a network request with it. */
import { parseCsv, buildYourReport, findingTexts, FIELD_LABELS, KINDS, MAX_BYTES } from './lib/csv.js';
import { jiraCsv, linearCsv } from './lib/sample.js';

const $ = (id) => document.getElementById(id);
const panel = $('yd');
if (panel) {
  const COLUMN_FIELDS = ['key', 'created', 'resolved', 'started', 'updated', 'status'];
  let rows = null, fileName = '', overrides = { mapping: {}, kinds: {} };
  let statusKey = null; // rebuilds the status table only when the set of statuses changes

  const say = (text) => { const m = $('yd-msg'); m.textContent = text || ''; m.hidden = !text; };
  const el = (tag, attrs, text) => { const n = document.createElement(tag); if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]); if (text != null) n.textContent = text; return n; };

  function setBusy(on) { panel.setAttribute('aria-busy', on ? 'true' : 'false'); }

  /* ---- loading a file ---- */
  function load(text, name) {
    let table;
    try { table = parseCsv(text); } catch (e) { table = []; }
    if (table.length < 2) { rows = null; say('That file has no rows to read. It should be a CSV with a header row and one row per item.'); $('yd-read').hidden = true; window.AOShowcase.clear(); return; }
    rows = table; fileName = name; overrides = { mapping: {}, kinds: {} }; statusKey = null;
    $('yd-cols').textContent = '';
    run(true);
  }
  function readFile(file) {
    say('');
    if (!file) return;
    if (file.size > MAX_BYTES) { say('That file is ' + Math.round(file.size / 1048576) + ' MB. The limit is ' + Math.round(MAX_BYTES / 1048576) + ' MB: export a narrower date range or fewer columns.'); return; }
    setBusy(true);
    file.text().then((t) => { load(t, file.name); }, () => say('That file could not be read.')).finally(() => setBusy(false));
  }

  /* ---- build and draw ---- */
  function run(fresh) {
    const res = buildYourReport(rows, overrides);
    readout(res, fresh);
    const nm = $('yd-name'); nm.textContent = fileName; nm.hidden = false; $('yd-or').hidden = true;
    panel.setAttribute('data-yd', 'ready');
    if (res.error) { say(res.error); window.AOShowcase.clear(); if (res.mapping) $('yd-read').open = true; return; }
    say('');
    const facts = res.report.facts;
    window.AOShowcase.showLocal({ ...res.report, historyPending: false, insights: { ...(findingTexts(facts) || {}), generatedAt: res.report.generatedAt } });
  }

  /* ---- "How the file was read": the columns used and how each status was grouped ---- */
  function readout(res, fresh) {
    const box = $('yd-read');
    if (!res.mapping) { box.hidden = true; return; }
    box.hidden = false;
    if (fresh) box.open = false;
    const c = res.counts;
    $('yd-read-s').textContent = 'How the file was read' + (res.notes && res.notes.length ? ' (' + res.notes.length + (res.notes.length === 1 ? ' note' : ' notes') + ')' : '');
    $('yd-counts').textContent = c ? c.rows.toLocaleString('en-GB') + ' rows read. ' + c.finished.toLocaleString('en-GB') + ' finished items, ' + c.finishedInWindow.toLocaleString('en-GB') + ' of them in the last 26 weeks.' : '';
    // One selector per column the maths uses, set to what was detected. Choosing another column re-reads the file.
    const cols = $('yd-cols');
    if (!cols.childNodes.length) {
      COLUMN_FIELDS.forEach((f) => {
        const wrap = el('label', { class: 'yd-col' });
        wrap.appendChild(el('span', null, FIELD_LABELS[f] + (f === 'created' ? ' *' : '')));
        const sel = el('select', { 'data-field': f });
        sel.appendChild(el('option', { value: '-1' }, 'Not in the file'));
        res.columns.forEach((name, i) => { if (name) sel.appendChild(el('option', { value: String(i) }, name)); });
        sel.addEventListener('change', () => { overrides.mapping[f] = Number(sel.value); if (f === 'status') overrides.kinds = {}; run(false); });
        wrap.appendChild(sel); cols.appendChild(wrap);
      });
    }
    cols.querySelectorAll('select').forEach((sel) => { const v = res.mapping[sel.getAttribute('data-field')]; sel.value = String(v == null ? -1 : v); });
    // Statuses
    const key = res.statuses ? res.statuses.map((s) => s.name).join('|') + '#' + res.mapping.status : '';
    if (key !== statusKey) {
      statusKey = key;
      const tb = $('yd-statuses'); tb.textContent = '';
      (res.statuses || []).forEach((s) => {
        const tr = el('tr'); tr.appendChild(el('th', { scope: 'row' }, s.name)); tr.appendChild(el('td', { class: 'num' }, s.count.toLocaleString('en-GB')));
        const td = el('td'), sel = el('select', { 'aria-label': 'How to count ' + s.name });
        Object.keys(KINDS).forEach((k) => { const o = el('option', { value: k }, KINDS[k]); sel.appendChild(o); });
        sel.value = s.kind;
        sel.addEventListener('change', () => { overrides.kinds[s.name] = sel.value; run(false); });
        td.appendChild(sel); tr.appendChild(td); tb.appendChild(tr);
      });
    }
    const notes = $('yd-notes'); notes.textContent = '';
    (res.notes || []).forEach((n) => notes.appendChild(el('li', null, n)));
  }

  /* ---- wiring ---- */
  $('yd-file').addEventListener('change', (e) => { readFile(e.target.files && e.target.files[0]); e.target.value = ''; });
  const drop = $('yd-drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));
  panel.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => {
    const kind = b.getAttribute('data-example');
    say('');
    load(kind === 'linear' ? linearCsv(Date.now()) : jiraCsv(Date.now()), kind === 'linear' ? 'Example Linear-style export' : 'Example Jira-style export');
  }));
  // Example files to download, to try the upload itself. Each is generated here, relative to today.
  [['yd-dl-jira', jiraCsv], ['yd-dl-linear', linearCsv]].forEach(([id, make]) => {
    const a = $(id); if (!a) return;
    try { a.href = URL.createObjectURL(new Blob([make(Date.now())], { type: 'text/csv' })); } catch (e) { a.hidden = true; }
  });
}
