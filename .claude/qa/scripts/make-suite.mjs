#!/usr/bin/env node
// Turns a selection (or a filter over the catalog) into runnable commands for any supported stack:
// grouped per build unit (Maven/Gradle module, package.json, *.csproj, Python project) and per stack driver.
// Java/TestNG gets suite XML; JS/Python/.NET get filtered runner commands (chunked under OS command-length
// limits); Gherkin gets feature:line lists for the unit's Cucumber flavour.
// Usage:
//   node .claude/qa/scripts/make-suite.mjs --selection <file|latest> [--run <runId>]
//   node .claude/qa/scripts/make-suite.mjs --module orders [--group smoke] [--app api] [--run <runId>]
//   node .claude/qa/scripts/make-suite.mjs --tests "<id1>,<id2>" [--run <runId>]
// Output: <runDir>/suites/ (with --run) or .qa/suites/, plus commands.json. Reports go to <runDir>/reports/.
// Command templates: qa.config.json → automation.runner.commands.<kind> (testng, junit, gradle, cucumber,
// playwright, jest, vitest, mocha, cypress, pytest, dotnet, behave, cucumber-js) or runner.command (TestNG).
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, loadConfig, parseArgs, fail, out } from './lib/common.mjs';
import { loadCatalog, buildModuleResolver } from './lib/catalog.mjs';
import { driverById } from './lib/drivers/index.mjs';

const args = parseArgs();
const cfg = loadConfig();
const root = repoRoot();
const cat = loadCatalog(cfg);
const byId = new Map(cat.tests.map((t) => [t.id, t]));
const list = (v) => (v && v !== true ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

let ids;
if (args.selection) {
  let f = String(args.selection);
  if (f === 'latest') {
    const dir = path.join(root, '.qa/selections');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort() : [];
    if (!files.length) fail('No selections in .qa/selections/. Run select-regression.mjs first.');
    f = path.join(dir, files.at(-1));
  }
  ids = JSON.parse(fs.readFileSync(path.resolve(root, f), 'utf8')).tests || [];
} else if (args.tests) {
  ids = list(args.tests);
} else if (args.module || args.group || args.app) {
  ids = cat.tests.filter((t) => t.enabled !== false && (!args.module || list(args.module).includes(t.module)) &&
    (!args.group || t.groups.includes(String(args.group))) && (!args.app || t.appType === args.app)).map((t) => t.id);
} else fail('Pass --selection, --tests, or --module/--group/--app');

const missing = ids.filter((id) => !byId.has(id));
const tests = ids.map((id) => byId.get(id)).filter(Boolean);
if (!tests.length) fail(`Nothing to run (${missing.length} ids not in catalog).`);

const runDir = args.run ? path.join(root, cfg.paths.runs, String(args.run)) : null;
const outDir = runDir ? path.join(runDir, 'suites') : path.join(root, '.qa/suites');
const reportDir = runDir ? path.join(runDir, 'reports') : path.join(root, '.qa/suites/reports');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(reportDir, { recursive: true });
const posix = (p) => p.split(path.sep).join('/');

const runner = cfg.automation?.runner || {};
const resolveBuild = buildModuleResolver(root);
const groups = new Map();                            // `${unit}|${driver}` -> tests
for (const t of tests) {
  const k = `${t.buildModule}|${t.driver || (t.kind === 'cucumber' ? 'gherkin' : 'java')}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(t);
}

const entries = [];
for (const [k, ts] of groups) {
  const [unit, driverId] = k.split('|');
  const driver = driverById[driverId];
  if (!driver) { entries.push({ unit, driver: driverId, tests: ts.length, error: 'unknown driver' }); continue; }
  const safe = `${unit === '.' ? 'root' : unit.replace(/[^\w.-]+/g, '_')}${groups.size > 1 && [...groups.keys()].filter((x) => x.startsWith(unit + '|')).length > 1 ? '-' + driverId : ''}`;
  const unitMarkers = cat.units?.[unit] || resolveBuild.markers(unit);
  const res = driver.suite({ unit, unitMarkers, tests: ts, outDir, safe, runner, root });
  for (const f of res.files) fs.writeFileSync(f.path, f.content);
  entries.push({
    unit, driver: driverId, tests: ts.length,
    files: res.files.map((f) => posix(path.relative(root, f.path))),
    commands: res.commands.map((c) => ({ ...c, command: c.command.replace(/\{reportDir\}/g, () => posix(reportDir)).replace(/\s+/g, ' ').trim() })),
  });
}

const commandsFile = path.join(outDir, 'commands.json');
fs.writeFileSync(commandsFile, JSON.stringify(entries, null, 2) + '\n');
const SHOW = 8;
const totalCommands = entries.reduce((n, e) => n + (e.commands?.length || 0), 0);
out({
  tests: tests.length,
  groups: entries.length,
  commands: totalCommands,
  byDriver: entries.reduce((o, e) => ((o[e.driver] = (o[e.driver] || 0) + e.tests), o), {}),
  missingFromCatalog: missing.slice(0, 10),
  outDir: posix(path.relative(root, outDir)),
  reportDir: posix(path.relative(root, reportDir)),
  commandsFile: posix(path.relative(root, commandsFile)),
  runs: entries.length <= SHOW ? entries.map(({ files, ...e }) => e)
    : [...entries.slice(0, SHOW).map(({ files, ...e }) => e), `… +${entries.length - SHOW} more groups. Iterate over commandsFile (e.g. node -e) instead of reading it into context.`],
  notes: [
    'Run each command from the repo root (commands cd into their unit when needed). Commands use POSIX shell syntax (Git Bash on Windows).',
    'Groups are independent and may run in parallel if the environment allows (automation.runner.parallelModules).',
    'After running: node .claude/qa/scripts/parse-results.mjs --run <runId>',
  ],
});
