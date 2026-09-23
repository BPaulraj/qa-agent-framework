// Test catalog: indexes existing automated tests of any supported stack (see drivers/index.mjs) into
// lightweight entries, so agents can search thousands of tests without reading source.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { repoRoot, walk, matchGlob, readData } from './common.mjs';
import { drivers, classify, allMarkers } from './drivers/index.mjs';

export { humanize } from './scan.mjs';
export { parseJava } from './drivers/java.mjs';
export { parseFeature } from './drivers/gherkin.mjs';

export const CATALOG_FILE = '.qa/catalog.json';
export const MODULE_MAP_FILE = '.qa/module-map.json';
export const CATALOG_VERSION = 2;

// ---------- build unit lookup (nearest dir with any driver's marker: pom.xml, package.json, *.csproj, ...) ----------
export function buildModuleResolver(root, markers = allMarkers) {
  const dirCache = new Map();          // dir -> matched marker names ([] if none)
  const markersIn = (dir) => {
    if (!dirCache.has(dir)) {
      let names = [];
      try { names = fs.readdirSync(path.join(root, dir)); } catch { /* missing */ }
      dirCache.set(dir, names.filter((n) => markers.some((mk) => (typeof mk === 'string' ? n === mk : mk.test(n)))));
    }
    return dirCache.get(dir);
  };
  const unitCache = new Map();
  const resolve = (relFile) => {
    let dir = path.posix.dirname(relFile);
    const visited = [];
    for (;;) {
      if (unitCache.has(dir)) { const v = unitCache.get(dir); visited.forEach((d) => unitCache.set(d, v)); return v; }
      visited.push(dir);
      if (markersIn(dir).length) { visited.forEach((d) => unitCache.set(d, dir)); return dir; }
      if (dir === '.' || dir === '') { visited.forEach((d) => unitCache.set(d, '.')); return '.'; }
      dir = path.posix.dirname(dir);
    }
  };
  resolve.markers = (unit) => markersIn(unit === '' ? '.' : unit);
  return resolve;
}

export function loadModuleMap(root = repoRoot(), packs = []) {
  const modules = {};
  const sources = [];
  for (const pack of packs) {
    const f = path.join(root, '.claude/skills', pack, 'module-map.json');
    if (fs.existsSync(f)) { Object.assign(modules, readData(f).modules || {}); sources.push(f); }
  }
  const local = path.join(root, MODULE_MAP_FILE);
  if (fs.existsSync(local)) { Object.assign(modules, readData(local).modules || {}); sources.push(local); }
  return { modules, sources };
}

export function moduleForTestFile(modules, relFile) {
  for (const [k, m] of Object.entries(modules)) if ((m.testPaths || []).some((g) => matchGlob(g, relFile))) return k;
  return null;
}

const gitHead = (root) => { try { return execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
const gitDirty = (root) => {
  try {
    return execSync('git status --porcelain -- "*.java" "*.feature" "*.ts" "*.tsx" "*.js" "*.jsx" "*.mjs" "*.cjs" "*.py" "*.cs"', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().length > 0;
  } catch { return true; }
};

/** Scan the repo with every driver and build the catalog. */
export function buildCatalog(cfg) {
  const root = repoRoot();
  const { modules } = loadModuleMap(root, cfg?.packs || []);
  const resolveBuild = buildModuleResolver(root);
  // Never index the framework itself or QA artefacts.
  const files = walk(root, { maxDepth: 25, filter: (f) => !/^\.(claude|qa)\//.test(f) && classify(f) !== null });
  const tests = [];
  const sharedDirs = {};
  const perDriver = Object.fromEntries(drivers.map((d) => [d.id, { files: 0, testFiles: 0, tests: 0 }]));
  const units = {};
  for (const rel of files) {
    const { driver, cls } = classify(rel);
    const stats = perDriver[driver.id];
    stats.files++;
    let found = [];
    if (cls === 'test' || cls === 'maybe') {
      let text;
      try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
      try { found = driver.parse(text, rel); } catch (e) { process.stderr.write(`[catalog] ${rel}: ${e.message}\n`); }
    }
    if (!found.length) {
      if (cls !== 'test') { const d = path.posix.dirname(rel); sharedDirs[d] = (sharedDirs[d] || 0) + 1; }
      continue;
    }
    stats.testFiles++;
    stats.tests += found.length;
    const buildModule = resolveBuild(rel);
    if (!units[buildModule]) units[buildModule] = resolveBuild.markers(buildModule);
    const module = moduleForTestFile(modules, rel);
    for (const t of found) tests.push({ ...t, driver: driver.id, module, buildModule });
  }
  for (const k of Object.keys(perDriver)) if (!perDriver[k].tests) delete perDriver[k];
  return {
    version: CATALOG_VERSION,
    generatedAt: new Date().toISOString(),
    commit: gitHead(root),
    counts: { tests: tests.length, testFiles: Object.values(perDriver).reduce((n, d) => n + d.testFiles, 0), unassigned: tests.filter((t) => !t.module).length },
    drivers: perDriver,
    units,
    sharedDirs,
    tests,
  };
}

export function writeCatalog(catalog) {
  const file = path.join(repoRoot(), CATALOG_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { tests, ...head } = catalog;
  // One test per line: compact but diff- and grep-friendly.
  fs.writeFileSync(file, JSON.stringify(head, null, 1).replace(/\n}$/, ',\n "tests": [\n') + tests.map((t) => '  ' + JSON.stringify(t)).join(',\n') + '\n ]\n}\n');
  return file;
}

/** Load the catalog, rebuilding it if missing, stale (commit / uncommitted test changes) or from an older version. */
export function loadCatalog(cfg, { rebuild = 'auto' } = {}) {
  const root = repoRoot();
  const file = path.join(root, CATALOG_FILE);
  let cat = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const stale = !cat || rebuild === true || cat.version !== CATALOG_VERSION ||
    (rebuild === 'auto' && (cat.commit !== gitHead(root) || gitDirty(root)));
  if (stale && rebuild !== false) { cat = buildCatalog(cfg); writeCatalog(cat); cat.rebuilt = true; }
  return cat;
}
