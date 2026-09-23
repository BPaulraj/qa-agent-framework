#!/usr/bin/env node
// Parses test reports of any supported stack into <runDir>/run.json, saves stack traces as evidence, copies
// failure screenshots, and clusters failures by root-cause signature (triage works on causes, not tests).
// Formats: TestNG (testng-results.xml), JUnit XML (surefire, gradle, pytest, Playwright, Vitest, Mocha xunit,
// Cypress, Cucumber, behave, JUnit loggers), .NET TRX, Jest/Vitest JSON.
// Usage: node .claude/qa/scripts/parse-results.mjs --run <runId> [--reports "glob1,glob2"] [--all] [--max-clusters 15]
//   Always scans <runDir>/reports/ (where make-suite points runners), plus runner.reports or the drivers' defaults.
//   --all  include report files older than the run start (default: only files written during the run)
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, loadConfig, parseArgs, matchGlob, readData, writeJson, fail, out } from './lib/common.mjs';
import { loadCatalog } from './lib/catalog.mjs';
import { drivers, driverById } from './lib/drivers/index.mjs';

const args = parseArgs();
const cfg = loadConfig();
const root = repoRoot();
if (!args.run) fail('--run <runId> is required (create one with new-run.mjs)');
const runDir = path.join(root, cfg.paths.runs, String(args.run));
const runFile = path.join(runDir, 'run.json');
if (!fs.existsSync(runFile)) fail(`run.json not found in ${runDir}`);
const run = readData(runFile);
const since = args.all ? 0 : Date.parse(run.startedAt) - 5000;
const posix = (p) => p.split(path.sep).join('/');
const runRel = posix(path.relative(root, runDir));

const runner = cfg.automation?.runner || {};
const globs = [
  `${runRel}/reports/**/*.xml`, `${runRel}/reports/**/*.trx`, `${runRel}/reports/**/*.json`,
  ...(args.reports && args.reports !== true ? String(args.reports).split(',') : runner.reports || drivers.flatMap((d) => d.defaultReports || [])),
];

// walk() skips target/build dirs for speed; reports and screenshots live there, so search explicitly.
function findFiles(patterns) {
  const hits = [];
  (function find(dir, depth) {
    if (depth > 14) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = posix(path.relative(root, abs));
      if (e.isDirectory()) {
        if (['node_modules', '.git', '.claude', 'src', '.venv', 'venv'].includes(e.name)) continue;
        if (e.name === '.qa' && !runRel.startsWith('.qa')) continue;
        if (rel.startsWith('.qa') && !(runRel.startsWith(rel) || rel.startsWith(runRel))) continue;   // only this run inside .qa
        find(abs, depth + 1);
      } else if (patterns.some((g) => matchGlob(g, rel))) hits.push(rel);
    }
  })(root, 0);
  return hits;
}
let reportFiles = [...new Set(findFiles(globs))].filter((f) => /\.(xml|trx|json)$/i.test(f) && fs.statSync(path.join(root, f)).mtimeMs >= since);
// Surefire+TestNG writes both testng-results.xml and TEST-*.xml: prefer testng-results.xml per directory
const testngDirs = new Set(reportFiles.filter((f) => f.endsWith('testng-results.xml')).map((f) => path.posix.dirname(f)));
reportFiles = reportFiles.filter((f) => f.endsWith('testng-results.xml') || !testngDirs.has(path.posix.dirname(f)));
if (!reportFiles.length) fail(`No report files newer than the run start matched: ${globs.join(', ')}. Use --all or --reports.`);

const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], unxml(m[2])]));
function unxml(s = '') {
  return s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&#x[aA];/g, '\n').replace(/&amp;/g, '&').trim();
}

// ---------- catalog lookup: exact id, then driver-provided report keys ----------
const cat = loadCatalog(cfg) || { tests: [] };
const byId = new Map(cat.tests.map((t) => [t.id, t]));
const keyIndex = new Map();                   // key -> Set(ids)
for (const t of cat.tests) {
  const d = driverById[t.driver] || (t.kind === 'cucumber' ? driverById.gherkin : driverById.java);
  for (const k of d.junitKeys(t, { unit: t.buildModule })) { if (!keyIndex.has(k)) keyIndex.set(k, new Set()); keyIndex.get(k).add(t.id); }
}
const stripParams = (s) => String(s || '').replace(/\s*[[(].*[\])]\s*$/, '').trim();
function resolveId(classname, name, fileAttr) {
  const n = String(name || ''), c = String(classname || '');
  const candidates = [`${c}#${n}`, `${c}#${stripParams(n)}`, fileAttr && `${fileAttr}#${n}`, `#${n}`, `#${stripParams(n)}`, `#${c} ${n}`, `#${c}.${n}`].filter(Boolean);
  for (const k of candidates) { const s = keyIndex.get(k); if (s && s.size === 1) return [...s][0]; }
  if (byId.has(`${c}#${n}`)) return `${c}#${n}`;
  return `${c}#${stripParams(n)}`;          // unknown to catalog: keep a readable id
}

const agg = new Map();                          // id -> { statuses[], durationMs, exception, message, stack, iterations }
const record = (id, status, durationMs, exception, message, stack) => {
  const a = agg.get(id) || { statuses: [], durationMs: 0, iterations: 0 };
  a.statuses.push(status); a.durationMs += durationMs || 0; a.iterations++;
  if (status !== 'passed' && !a.exception && (exception || message)) { a.exception = exception; a.message = message; a.stack = stack; }
  agg.set(id, a);
};
const excFromMessage = (msg) => (String(msg).match(/^\s*([\w.$]*(?:Error|Exception|Failure))\b/) || [])[1] || null;
const dur = (s) => { const m = String(s || '').match(/^(\d+):(\d+):([\d.]+)$/); return m ? Math.round(((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])) * 1000) : 0; };

for (const rel of reportFiles) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  if (rel.endsWith('.json')) {
    // Jest / Vitest JSON (jest-compatible): testResults[].assertionResults[]
    let j; try { j = JSON.parse(text); } catch { continue; }
    for (const file of j.testResults || []) {
      const fileRel = posix(path.relative(root, path.resolve(root, file.name || file.testFilePath || '')));
      for (const a of file.assertionResults || file.testResults || []) {
        const tp = [...(a.ancestorTitles || []), a.title];
        const exact = `${fileRel}#${tp.join(' > ')}`;
        const id = byId.has(exact) ? exact : resolveId(tp.slice(0, -1).join(' '), a.title, fileRel);
        const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
        const msg = (a.failureMessages || []).join('\n').replace(/\u001b\[[0-9;]*m/g, '');
        record(id, status, a.duration || 0, excFromMessage(msg) || (msg ? 'AssertionError' : null), msg.split('\n').find((l) => l.trim()) || '', msg);
      }
    }
  } else if (rel.endsWith('.trx')) {
    // .NET TRX: UnitTest definitions (className/name) + UnitTestResult outcomes
    const defs = new Map();
    for (const m of text.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g)) {
      const a = attrs(m[1]);
      const tm = m[2].match(/<TestMethod\b([^>]*)\/?>/);
      if (tm) { const ta = attrs(tm[1]); defs.set(a.id, { className: (ta.className || '').split(',')[0].trim(), method: ta.name }); }
    }
    for (const m of text.matchAll(/<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
      const a = attrs(m[1]);
      const inner = m[2] || '';
      const def = defs.get(a.testId) || {};
      const msg = unxml((inner.match(/<Message>([\s\S]*?)<\/Message>/) || [])[1] || '');
      const stack = unxml((inner.match(/<StackTrace>([\s\S]*?)<\/StackTrace>/) || [])[1] || '');
      const outcome = a.outcome || '';
      const status = outcome === 'Passed' ? 'passed' : /^(Failed|Error|Timeout)$/.test(outcome) ? 'failed' : outcome === 'Aborted' ? 'blocked' : 'skipped';
      const id = resolveId(def.className, def.method || stripParams(a.testName), null);
      record(id, status, dur(a.duration), excFromMessage(msg) || excFromMessage(stack) || (msg ? 'AssertionFailure' : null), msg.split('\n')[0], stack);
    }
  } else if (rel.endsWith('testng-results.xml')) {
    for (const cm of text.matchAll(/<class\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
      for (const tm of cm[2].matchAll(/<test-method\b([^>]*?)(?:\/>|>([\s\S]*?)<\/test-method>)/g)) {
        const a = attrs(tm[1]);
        if (a['is-config'] === 'true') continue;
        const inner = tm[2] || '';
        const ex = inner.match(/<exception\s+class="([^"]+)"/);
        const msg = inner.match(/<message>([\s\S]*?)<\/message>/);
        const st = inner.match(/<full-stacktrace>([\s\S]*?)<\/full-stacktrace>/);
        const status = a.status === 'PASS' ? 'passed' : a.status === 'FAIL' ? 'failed' : ex ? 'blocked' : 'skipped';
        record(resolveId(cm[1], a.name, null), status, Number(a['duration-ms'] || 0), ex?.[1], unxml(msg?.[1]), unxml(st?.[1]));
      }
    }
  } else {
    // JUnit XML family (incl. Mocha xunit, whose testcase attributes are the same)
    for (const tc of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const a = attrs(tc[1]);
      const inner = tc[2] || '';
      const f = inner.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
      const skipped = /<skipped\b/.test(inner);
      const fa = f ? attrs(f[2]) : {};
      const body = unxml(f?.[3] || '');
      const msg = fa.message || body.split('\n')[0] || '';
      const status = f ? 'failed' : skipped ? 'skipped' : 'passed';
      const fileAttr = a.file ? posix(path.relative(root, path.resolve(root, a.file))) : null;
      // Some reporters (Playwright, Cypress) put a generic word in `type`; prefer the error named in the message.
      const type = /^(failure|error|assertionfailure)?$/i.test(fa.type || '') ? null : fa.type;
      record(resolveId(a.classname, a.name, fileAttr), status, Math.round(Number(a.time || 0) * 1000),
        type || excFromMessage(body) || excFromMessage(msg) || fa.type, msg, body);
    }
  }
}

// ---------- clusters ----------
const normalize = (s = '') => s.split('\n')[0].toLowerCase()
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
  .replace(/https?:\/\/\S+/g, '<url>').replace(/"[^"]*"|'[^']*'/g, '<str>').replace(/\b0x[0-9a-f]+\b/g, '<hex>')
  .replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120);
const clusters = new Map();

fs.mkdirSync(path.join(runDir, 'evidence', 'stacktraces'), { recursive: true });
const results = [];
for (const [id, a] of agg) {
  const status = a.statuses.includes('failed') ? 'failed' : a.statuses.includes('blocked') ? 'blocked'
    : a.statuses.every((s) => s === 'skipped') ? 'skipped' : 'passed';
  const r = { caseId: id, status, mode: 'scripted', durationMs: a.durationMs, evidence: [] };
  if (a.iterations > 1) r.notes = `${a.iterations} iterations (${a.statuses.filter((s) => s === 'failed').length} failed)`;
  if (status === 'failed' || status === 'blocked') {
    const sig = `${a.exception || 'unknown'} :: ${normalize(a.message)}`;
    if (!clusters.has(sig)) clusters.set(sig, { id: clusters.size + 1, exception: a.exception || null, message: (a.message || '').split('\n')[0].slice(0, 300), tests: [], modules: new Set() });
    const c = clusters.get(sig);
    c.tests.push(id); c.modules.add(byId.get(id)?.module || '(unknown)');
    if (a.stack || a.message) {
      const f = path.join('evidence', 'stacktraces', id.replace(/[^\w.#-]+/g, '_').slice(0, 180) + '.txt');
      fs.writeFileSync(path.join(runDir, f), `${a.exception || ''}\n${a.message || ''}\n\n${a.stack || ''}`.trim() + '\n');
      r.evidence.push(posix(f));
    }
    r.failure = { actual: `${a.exception ? a.exception.split('.').pop() + ': ' : ''}${(a.message || '').split('\n')[0]}`.slice(0, 500),
      classification: 'untriaged', cluster: c.id };
  }
  results.push(r);
}

// ---------- evidence (screenshots etc. written by the framework during the run) ----------
let copied = 0;
if (runner.evidenceDirs?.length) {
  // Match on the whole relative path: Playwright/Cypress name folders after the test title, others name files after the method.
  const norm = (s) => String(s).toLowerCase().replace(/@[\w:-]+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const failed = results.filter((r) => r.failure).map((r) => {
    const t = byId.get(r.caseId);
    return [r, norm(t?.method || t?.title || r.caseId.split(/[#.>]/).pop())];
  }).filter(([, k]) => k && k.length >= 4);
  for (const f of findFiles(runner.evidenceDirs)) {
    const abs = path.join(root, f);
    if (fs.statSync(abs).mtimeMs < since) continue;
    const hay = norm(f);
    for (const [r, key] of failed) {
      if (!hay.includes(key)) continue;
      const dest = path.join('evidence', `${key.slice(0, 60)}-${path.basename(f)}`);
      fs.copyFileSync(abs, path.join(runDir, dest));
      r.evidence.push(posix(dest));
      copied++;
    }
  }
}

// ---------- merge into run.json ----------
const keep = (run.results || []).filter((r) => !agg.has(r.caseId));
run.results = [...keep, ...results];
run.clusters = [...clusters.values()].map((c) => ({ id: c.id, exception: c.exception, message: c.message, count: c.tests.length,
  modules: [...c.modules], tests: c.tests.slice(0, 200), classification: 'untriaged' }));
run.finishedAt ||= new Date().toISOString();
writeJson(runFile, run);

const count = (s) => results.filter((r) => r.status === s).length;
const executed = count('passed') + count('failed');
const failedByModule = results.filter((r) => r.status === 'failed').reduce((o, r) => { const m = byId.get(r.caseId)?.module || '(unknown)'; o[m] = (o[m] || 0) + 1; return o; }, {});
out({
  run: args.run,
  reportFiles: reportFiles.length,
  parsed: results.length,
  passed: count('passed'), failed: count('failed'), blocked: count('blocked'), skipped: count('skipped'),
  passRate: executed ? `${Math.round((count('passed') / executed) * 1000) / 10}%` : 'n/a',
  notInCatalog: results.filter((r) => !byId.has(r.caseId)).length,
  notInCatalogSample: results.filter((r) => !byId.has(r.caseId)).slice(0, 5).map((r) => r.caseId),
  clusters: run.clusters.length,
  topClusters: [...run.clusters].sort((a, b) => b.count - a.count).slice(0, Number(args['max-clusters'] || 15))
    .map((c) => ({ id: c.id, count: c.count, exception: c.exception?.split('.').pop(), message: c.message.slice(0, 140), modules: c.modules.slice(0, 5), sample: c.tests.slice(0, 3) })),
  failedByModule: Object.entries(failedByModule).sort((a, b) => b[1] - a[1]).slice(0, 15),
  evidenceCopied: copied,
  next: count('failed') + count('blocked') ? 'Triage per cluster (qa-triager), not per test.' : 'All green.',
});
