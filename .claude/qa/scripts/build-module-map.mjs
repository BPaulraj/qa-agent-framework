#!/usr/bin/env node
// Generates/refreshes .qa/module-map.json (components) from the test code structure.
// Usage: node .claude/qa/scripts/build-module-map.mjs [--strategy auto|build|package|path|folder] [--root <dir>] [--min 5] [--dry-run]
//   build   : each build unit with tests is a component (Maven/Gradle module, package.json, *.csproj, Python project)
//   package : namespace segment after the common prefix (Java packages, .NET namespaces: com.org.qa.<component>...)
//   path    : directory segment after the common test-directory prefix (JS/TS, Python, any stack)
//   folder  : each immediate subfolder of --root is a component
//   auto    : build if >= --min units contain tests, else package (mostly Java/.NET), else path
// Merge rules: testPaths/testCount are regenerated; every other field you add (areaPaths, appRepos,
// adoTags, dependsOn, journeys, pack, owner, description) is preserved. Set "lockTestPaths": true on an
// entry to keep hand-written testPaths.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, loadConfig, parseArgs, readData, writeJson, matchGlob, out } from './lib/common.mjs';
import { buildCatalog, writeCatalog, buildModuleResolver, MODULE_MAP_FILE } from './lib/catalog.mjs';

const args = parseArgs();
const cfg = loadConfig({ required: false }) || { packs: [] };
const root = repoRoot();
const DRY = Boolean(args['dry-run']);
const key = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';

// Catalog without module assignment (ignore existing map for discovery)
const cat = buildCatalog({ ...cfg, packs: [] });
const tests = cat.tests;
const codeTests = tests.filter((t) => t.kind !== 'cucumber');
const nsTests = codeTests.filter((t) => t.class && t.class.includes('.') && (t.driver === 'java' || t.driver === 'dotnet'));
const features = tests.filter((t) => t.kind === 'cucumber');

const buildMods = [...new Set(tests.map((t) => t.buildModule))].filter((b) => b !== '.');
let strategy = args.strategy || 'auto';
if (strategy === 'auto') {
  strategy = buildMods.length >= Number(args.min || 5) ? 'build' : args.root ? 'folder'
    : nsTests.length >= codeTests.length * 0.7 && nsTests.length ? 'package' : 'path';
}

const found = {}; // key -> { testPaths:Set, tests:number }
const add = (k, glob, n = 1) => { (found[k] ??= { testPaths: new Set(), tests: 0 }).testPaths.add(glob); found[k].tests += n; };

if (strategy === 'build') {
  const names = {};
  for (const b of buildMods) { const k = key(path.posix.basename(b)); names[k] = (names[k] || 0) + 1; }
  for (const t of tests) {
    if (t.buildModule === '.') continue;
    let k = key(path.posix.basename(t.buildModule));
    if (names[k] > 1) k = key(t.buildModule);                    // disambiguate same-named modules
    add(k, `${t.buildModule}/**`);
  }
} else if (strategy === 'folder') {
  const base = String(args.root || '').replace(/\/+$/, '');
  if (!base) { console.error('--root <dir> is required for folder strategy'); process.exit(1); }
  for (const t of tests) {
    if (!t.file.startsWith(base + '/')) continue;
    const seg = t.file.slice(base.length + 1).split('/')[0];
    add(key(seg), `${base}/${seg}/**`);
  }
} else {
  const commonPrefix = (lists) => {
    let prefix = lists[0] || [];
    for (const p of lists) { let i = 0; while (i < prefix.length && prefix[i] === p[i]) i++; prefix = prefix.slice(0, i); }
    // Don't let a single-component repo collapse everything into the prefix
    if (lists.length && lists.every((p) => p.length === prefix.length)) prefix = prefix.slice(0, -1);
    return prefix;
  };
  // package: namespace segment after the common prefix (Java packages, .NET namespaces)
  const pathTests = strategy === 'package' ? codeTests.filter((t) => !nsTests.includes(t)) : codeTests;
  if (strategy === 'package') {
    const prefix = commonPrefix(nsTests.map((t) => t.class.split('.').slice(0, -1)));
    for (const t of nsTests) {
      const segs = t.class.split('+')[0].split('.').slice(0, -1);
      const seg = segs[prefix.length] || 'root';
      const pkgPath = segs.join('/');
      const dir = path.posix.dirname(t.file);
      if (dir.endsWith(pkgPath)) {                       // Java-style: folders mirror packages
        const srcRoot = dir.slice(0, dir.length - pkgPath.length).replace(/\/$/, '');
        add(key(seg), `${srcRoot ? srcRoot + '/' : ''}${[...prefix, seg].join('/')}/**`);
      } else add(key(seg), `${dir}/*`);                 // .NET-style: namespaces don't mirror folders
    }
  }
  // path: per test root (top-level folder, e.g. e2e/, api-tests/), the folder after that root's common prefix.
  // Same-named components across roots merge, so "checkout" covers its UI and API tests in different stacks.
  if (pathTests.length) {
    const dirsOf = (t) => path.posix.dirname(t.file).split('/').filter((s) => s && s !== '.');
    const byRoot = new Map();
    for (const t of pathTests) { const r = dirsOf(t)[0] || '.'; if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(t); }
    for (const ts of byRoot.values()) {
      const prefix = commonPrefix(ts.map(dirsOf));
      const base = prefix.join('/');
      for (const t of ts) {
        const seg = dirsOf(t)[prefix.length];
        if (seg) add(key(seg.replace(/^(test_|tests?[-_])/, '')), `${base ? base + '/' : ''}${seg}/**`);
        else add(key(path.posix.basename(t.file).replace(/\.(spec|test|cy|e2e)?\.?[^.]+$/, '').replace(/^test_|_test$/, '')), t.file);
      }
    }
  }
}

// Cucumber features: component = folder after ".../features/" (merged into a matching component if one exists)
if (strategy !== 'build' && strategy !== 'folder') {
  const norm = (s) => s.replace(/[-_]/g, '');
  for (const t of features) {
    const m = t.file.match(/^(.*?\/?features)\/([^/]+)\//i);
    const seg = m ? m[2] : 'features';
    const k = Object.keys(found).find((x) => norm(x) === norm(key(seg))) || key(seg);
    add(k, m ? `${m[1]}/${seg}/**` : `${path.posix.dirname(t.file)}/**`);
  }
}

// Shared code (Java dirs with no tests) -> sharedPaths; changes there suggest a broad regression.
const testsPerBuild = tests.reduce((o, t) => ((o[t.buildModule] = (o[t.buildModule] || 0) + 1), o), {});
const resolveBuild = buildModuleResolver(root);
const componentGlobs = Object.values(found).flatMap((v) => [...v.testPaths]);
const shared = new Set();
for (const dir of Object.keys(cat.sharedDirs)) {
  if (componentGlobs.some((g) => matchGlob(g, `${dir}/x.java`))) continue;   // support code inside a component
  const owner = resolveBuild(`${dir}/x.java`);
  if (owner !== '.' && !testsPerBuild[owner]) shared.add(`${owner}/**`);      // whole build module without tests
  else {
    const m = dir.match(/^(.*?(?:^|\/)(?:core|common|framework|base|utils?|support|shared|lib|helpers?|config))(\/|$)/i);
    shared.add(`${m ? m[1] : dir}/**`);
  }
}

// Merge with existing map
const file = path.join(root, MODULE_MAP_FILE);
const existing = fs.existsSync(file) ? readData(file) : {};
const modules = existing.modules || {};
const added = [], updated = [], stale = [];
for (const [k, v] of Object.entries(found)) {
  const prev = modules[k];
  const testPaths = [...v.testPaths].sort();
  if (!prev) {
    modules[k] = { description: '', testPaths, testCount: v.tests, areaPaths: [], adoTags: [], appRepos: [], dependsOn: [], journeys: [], pack: null, owner: '' };
    added.push(k);
  } else {
    if (!prev.lockTestPaths) prev.testPaths = testPaths;
    if (prev.testCount !== v.tests) updated.push(k);
    prev.testCount = v.tests;
  }
}
for (const k of Object.keys(modules)) if (!found[k] && !modules[k].lockTestPaths && modules[k].testPaths?.length) { modules[k].stale = true; stale.push(k); }
for (const k of Object.keys(found)) delete modules[k].stale;

const sortedModules = Object.fromEntries(Object.entries(modules).sort(([a], [b]) => a.localeCompare(b)));
const result = {
  $comment: existing.$comment || 'Components of this repo. testPaths/testCount are generated by build-module-map.mjs; fill areaPaths (ADO area path globs), appRepos ([{repo, paths}]), adoTags, dependsOn (max-depth applies), journeys, pack, owner. sharedPaths is regenerated; put hand-maintained shared globs in extraSharedPaths. Changes under either suggest a broad regression.',
  generatedBy: `build-module-map.mjs --strategy ${strategy}`,
  sharedPaths: [...shared].sort().slice(0, 50),
  extraSharedPaths: existing.extraSharedPaths || [],
  modules: sortedModules,
};
if (!DRY) {
  writeJson(file, result);
  writeCatalog(buildCatalog(cfg)); // re-index with module assignments
}

const assigned = Object.values(found).reduce((n, v) => n + v.tests, 0);
out({
  dryRun: DRY,
  file: MODULE_MAP_FILE,
  strategy,
  buildModulesWithTests: buildMods.length,
  components: Object.keys(sortedModules).length,
  added: added.length, updatedCounts: updated.length,
  stale,
  testsAssigned: `${assigned}/${tests.length}`,
  largest: Object.entries(found).sort((a, b) => b[1].tests - a[1].tests).slice(0, 15).map(([k, v]) => `${k}: ${v.tests}`),
  sharedPaths: result.sharedPaths.slice(0, 15),
  next: 'Review component names, then fill areaPaths and appRepos per component (see qa-regression-testing skill). Unknown ones can stay empty.',
});
