// Updates the IL-IPSC raw data files from endofscoring.com and refreshes the
// IDX block inside the dashboards. Runs in GitHub Actions (Node 20+, no deps).
//
//   node scripts/update-ipsc.mjs            -> update files in the repo root
//   DRY_RUN=1 node scripts/update-ipsc.mjs  -> report only, write nothing
//
// What it does
//  1. Reads the parts list from the `var IDX=` line in index.html.
//  2. Loads every part (il-ipsc-raw-..._partN.json).
//  3. Asks the API for all public matches, keeps the Israeli ones that already
//     happened, and fetches the ones that are new, were unpublished before,
//     or are recent (scores can still change for a couple of weeks).
//  4. Writes the matches into the right part (new part when the last is full),
//     updates range/fetched/unpublished, and rewrites the IDX line in
//     index.html and dashboard.html (parts, shooters index, fetched date).

import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.endofscoring.com/api/';
const ROOT = process.cwd();
const HTML_FILES = ['index.html', 'dashboard.html'];
const COUNTRY = 'IL';
const REFRESH_DAYS = 14;               // re-fetch matches from the last N days
const MAX_PART_BYTES = 15 * 1024 * 1024; // start a new part above this size
const DRY = !!process.env.DRY_RUN;
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- API ----------
async function get(p) {
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch(API + p, { headers: { accept: 'application/json', 'user-agent': 'shooters-comparison-updater' } });
      if ([401, 403, 404].includes(r.status)) return { status: r.status };
      if (r.ok) return { status: 200, data: await r.json() };
    } catch (e) { /* retry */ }
    await sleep(1500 * (t + 1));
  }
  return { status: 0 };
}

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => (d && d.year ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : '');
function todayIL() {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return s; // YYYY-MM-DD
}
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function numOf(pid) { pid = (pid || '').trim(); if (pid.indexOf('|') < 0) return ''; const p = pid.split('|'); return p[0] === 'IL' ? p[1].trim() : ''; }

function readIdx(html) {
  const i = html.indexOf('var IDX=');
  if (i < 0) return null;
  const j = html.indexOf('\n', i);
  const line = html.slice(i, j < 0 ? undefined : j);
  const json = line.slice(8).replace(/;\s*$/, '');
  return { start: i, end: j < 0 ? html.length : j, semi: /;\s*$/.test(line), idx: JSON.parse(json) };
}

// Convert API objects to the raw format used in the part files.
function toRaw(m, stages, shooters, scores) {
  const byId = {};
  stages.forEach((s) => { byId[s.id] = s; });
  const out = {
    id: m.id, title: m.title, alias: m.alias, date: m.startDate, type: m.type, level: m.ipscLevel,
  };
  if (m.scoreMode !== undefined && m.scoreMode !== null) out.scoreMode = m.scoreMode;
  out.pub = m.scoresPublished;
  out.stages = (m.stages || []).map((id) => { const s = byId[id] || { id }; return { id: s.id, rounds: s.rounds, targets: s.targets, title: s.title }; });
  out.shooters = shooters.map((s) => ({ id: s.id, pid: s.publicId, name: s.name, club: s.club, div: s.division, cat: s.category, pf: s['power-factor'] }));
  out.scores = scores.filter((s) => !s.deleted).map((s) => {
    if (s.dq && !('time' in s)) return { s: s.shooterId, i: s.stageIdx, pen: s.penaltiesByType, m: s.modified, dq: s.dq };
    const o = { s: s.shooterId, i: s.stageIdx, t: s.time, h: s.scorePerTarget, p: s.poppers, tp: s.tenPointsPoppers, ns: s['no-shoots'], pen: s.penaltiesByType, sp: s.specialPenalty, b: s.bonusField, m: s.modified };
    if (s.dq) o.dq = s.dq;
    return o;
  });
  return out;
}

async function fetchMatch(id) {
  const mm = await get('matches/' + encodeURIComponent(id));
  if (mm.status !== 200 || !mm.data || !mm.data.startDate) return { state: 'error' };
  const m = mm.data;
  const sc = await get('matches/' + encodeURIComponent(m.id || id) + '/scores/');
  if (sc.status === 401 || sc.status === 403) return { state: 'unpublished', m };
  if (sc.status !== 200) return { state: 'error' };
  const scores = (sc.data && sc.data.scores) || [];
  if (!scores.length) return { state: 'unpublished', m };
  const sh = await get('matches/' + encodeURIComponent(m.id || id) + '/shooters/');
  if (sh.status !== 200) return { state: 'error' };
  let stages = [];
  const ids = m.stages || [];
  for (let k = 0; k < ids.length; k += 20) {
    const st = await get('stages/' + ids.slice(k, k + 20).join(','));
    if (st.status !== 200) return { state: 'error' };
    stages = stages.concat(Array.isArray(st.data) ? st.data : []);
  }
  if (!m.id) m.id = id;
  return { state: 'ok', raw: toRaw(m, stages, sh.data || [], scores) };
}

// ---------- main ----------
async function main() {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const I = readIdx(indexHtml);
  if (!I) throw new Error('var IDX= not found in index.html');
  const IDX = I.idx;
  const partFiles = IDX.parts.map((p) => p.file);
  const parts = partFiles.map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  const dirty = new Set();

  const where = new Map();      // match id -> part index
  const unpub = new Map();      // match id -> part index
  parts.forEach((p, k) => {
    (p.matches || []).forEach((m) => where.set(String(m.id), k));
    (p.unpublished || []).forEach((id) => unpub.set(String(id), k));
  });

  const today = todayIL();
  const list = await get('matches/');
  if (list.status !== 200) throw new Error('could not read match list');
  const all = Object.entries(list.data).filter(([, m]) => m && m.countryCode === COUNTRY && m.startDate);

  const todo = [];
  for (const [id, m] of all) {
    const d = dstr(m.startDate);
    if (!d || d > today) continue;                         // future match
    if (d < IDX.parts[0].range[0]) continue;               // before the data set
    const known = where.has(id), wasUnpub = unpub.has(id);
    const recent = daysBetween(d, today) <= REFRESH_DAYS;
    if (!known && !wasUnpub) todo.push({ id, d, why: 'new' });
    else if (wasUnpub && recent) todo.push({ id, d, why: 'unpublished' });
    else if (wasUnpub && !known && daysBetween(d, today) <= 120) todo.push({ id, d, why: 'unpublished' });
    else if (known && recent) todo.push({ id, d, why: 'refresh' });
  }
  todo.sort((a, b) => a.d.localeCompare(b.d));
  log(`IL matches: ${all.length}, to check: ${todo.length}`);

  const report = [];
  const touched = [];
  for (const t of todo) {
    const r = await fetchMatch(t.id);
    await sleep(300);
    if (r.state === 'error') { log(`! ${t.d} ${t.id} – fetch error, skipped`); continue; }
    if (r.state === 'unpublished') {
      if (!where.has(t.id) && !unpub.has(t.id)) {
        const k = parts.length - 1;
        parts[k].unpublished = parts[k].unpublished || [];
        parts[k].unpublished.push(t.id); unpub.set(t.id, k); dirty.add(k);
        report.push(`⏳ ${t.d} ${r.m.title} – scores not published yet`);
      }
      continue;
    }
    const raw = r.raw;
    // drop from unpublished lists
    if (unpub.has(t.id)) {
      const k = unpub.get(t.id);
      parts[k].unpublished = (parts[k].unpublished || []).filter((x) => String(x) !== t.id);
      unpub.delete(t.id); dirty.add(k);
    }
    if (where.has(t.id)) {
      const k = where.get(t.id), arr = parts[k].matches;
      const i = arr.findIndex((m) => String(m.id) === t.id);
      if (JSON.stringify(arr[i]) !== JSON.stringify(raw)) { arr[i] = raw; dirty.add(k); touched.push({ k, raw }); report.push(`🔄 ${t.d} ${raw.title} – updated`); }
      continue;
    }
    // choose part: the one whose range covers the date, else the last one
    let k = parts.findIndex((p) => p.range && t.d >= p.range[0] && t.d <= p.range[1]);
    if (k < 0) k = parts.length - 1;
    if (k === parts.length - 1 && Buffer.byteLength(JSON.stringify(parts[k])) > MAX_PART_BYTES && t.d > parts[k].range[1]) {
      parts.push({ fetched: '', part: '', range: [t.d, t.d], unpublished: [], matches: [] });
      const base = partFiles[0].replace(/_part\d+\.json$/, '');
      partFiles.push(`${base}_part${parts.length}.json`);
      k = parts.length - 1;
      log(`+ new part file ${partFiles[k]}`);
    }
    parts[k].matches.push(raw); where.set(t.id, k); dirty.add(k); touched.push({ k, raw });
    report.push(`➕ ${t.d} ${raw.title} – ${raw.shooters.length} shooters`);
  }

  if (!dirty.size) { log('No changes.'); summary(['אין תחרויות חדשות.']); return; }

  const now = new Date().toISOString();
  parts.forEach((p, k) => {
    p.matches.sort((a, b) => dstr(a.date).localeCompare(dstr(b.date)));
    const ds = p.matches.map((m) => dstr(m.date)).filter(Boolean);
    if (ds.length) p.range = [ds[0] < (p.range?.[0] || ds[0]) ? ds[0] : (p.range?.[0] || ds[0]), ds[ds.length - 1] > (p.range?.[1] || '') ? ds[ds.length - 1] : p.range[1]];
    p.part = `${k + 1}/${parts.length}`;
    if (dirty.has(k)) p.fetched = now;
  });

  // update the shooters index (keep existing entries, add bits for new matches)
  const s = JSON.parse(JSON.stringify(IDX.s || {}));
  touched.forEach(({ k, raw }) => (raw.shooters || []).forEach((sh) => {
    const key = numOf(sh.pid); if (!key) return;
    if (!s[key]) s[key] = [sh.name || '', sh.club || '', 0];
    s[key][2] |= (1 << k);
  }));
  const newIdx = { fetched: today, parts: parts.map((p, k) => ({ file: partFiles[k], range: p.range })), s };

  report.forEach((r) => log(r));
  if (DRY) { log('DRY_RUN – nothing written'); summary(report); return; }

  parts.forEach((p, k) => {
    if (dirty.has(k) || !fs.existsSync(path.join(ROOT, partFiles[k]))) fs.writeFileSync(path.join(ROOT, partFiles[k]), JSON.stringify(p));
  });
  for (const f of HTML_FILES) {
    const fp = path.join(ROOT, f);
    if (!fs.existsSync(fp)) continue;
    const html = fs.readFileSync(fp, 'utf8');
    const R = readIdx(html);
    if (!R) { log(`(no IDX in ${f})`); continue; }
    const line = 'var IDX=' + JSON.stringify(newIdx) + (R.semi ? ';' : '');
    fs.writeFileSync(fp, html.slice(0, R.start) + line + html.slice(R.end));
    log(`updated IDX in ${f}`);
  }
  summary(report);
}

function summary(lines) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) fs.appendFileSync(f, '### עדכון נתוני IPSC\n' + lines.map((l) => '- ' + l).join('\n') + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
