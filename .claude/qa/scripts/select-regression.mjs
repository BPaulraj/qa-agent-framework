#!/usr/bin/env node
// Impact-based regression selection for single-app repos and test-only monorepos.
//
// Change inputs (combine freely):
//   --modules a,b                      components you already know changed
//   --ado-ids 101,102                  ADO work items → components via areaPaths/adoTags, plus their linked PRs/commits
//   --ado-iteration "Proj\\Sprint 42"  all stories/bugs/PBIs in an iteration (optionally --ado-area "Proj\\Team")
//   --ado-query <savedQueryId>         a saved ADO query
//   --app-pr orders-api:123,web:77     app repo PRs → changed files → components via appRepos
//   --app-commit orders-api:<sha>      app repo commits → changed files → components via appRepos
//   --base <branch>                    diff of THIS repo (default when no other input is given)
// Options:
//   --max-depth 1                      dependsOn hops to follow (default regression.maxDepth or 1)
//   --out <file>                       full selection file (default .qa/selections/<timestamp>.json)
//
// Stdout is a bounded summary; the full list of test ids goes to the selection file, which
// make-suite.mjs and the executor consume.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { repoRoot, loadConfig, loadCases, matchGlob, parseArgs, writeJson, fail, out } from './lib/common.mjs';
import { loadCatalog, loadModuleMap } from './lib/catalog.mjs';

const args = parseArgs();
const cfg = loadConfig();
const root = repoRoot();
const list = (v) => (v === undefined || v === true ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const { modules, sources } = loadModuleMap(root, cfg.packs || []);
let sharedPaths = [];
try { const mm = JSON.parse(fs.readFileSync(path.join(root, '.qa/module-map.json'), 'utf8')); sharedPaths = [...(mm.sharedPaths || []), ...(mm.extraSharedPaths || [])]; } catch { /* none */ }

const reasons = new Map();                      // module -> Set(reason)
const hit = (mod, why) => { if (!reasons.has(mod)) reasons.set(mod, new Set()); reasons.get(mod).add(why); };
const unmapped = { adoItems: [], appFiles: [], localFiles: [] };
const directTests = new Set();
const inputs = {};
let broadImpact = [];

const normArea = (s) => String(s).replace(/\\/g, '/').toLowerCase();

// ---------- module matching ----------
function modulesForAppFile(repoName, file) {
  const out = [];
  for (const [k, m] of Object.entries(modules)) {
    for (const r of m.appRepos || []) {
      if (String(r.repo).toLowerCase() !== repoName.toLowerCase()) continue;
      if (!r.paths?.length || r.paths.some((g) => matchGlob(g, file))) { out.push(k); break; }
    }
  }
  return out;
}
function modulesForItem(item) {
  const area = normArea(item.areaPath);
  const tags = item.tags.map((t) => t.toLowerCase());
  return Object.entries(modules).filter(([, m]) =>
    (m.areaPaths || []).some((g) => matchGlob(normArea(g), area)) ||
    (m.adoTags || []).some((t) => tags.includes(String(t).toLowerCase()))).map(([k]) => k);
}

// ---------- 1. explicit modules ----------
for (const m of list(args.modules)) { inputs.modules = list(args.modules); if (!modules[m]) fail(`Unknown module "${m}"`); hit(m, 'named explicitly'); }

// ---------- 2. ADO work items and app repo changes ----------
const wantsAdo = args['ado-ids'] || args['ado-iteration'] || args['ado-query'] || args['app-pr'] || args['app-commit'];
if (wantsAdo) {
  const { createAdo } = await import('./lib/ado.mjs');
  const A = createAdo(cfg);
  const appChange = async (repoName, files, label) => {
    for (const f of files) {
      const mods = modulesForAppFile(repoName, f);
      if (mods.length) mods.forEach((mm) => hit(mm, label));
      else unmapped.appFiles.push(`${repoName}:${f}`);
    }
  };
  let ids = list(args['ado-ids']).map(Number);
  if (args['ado-iteration']) {
    const esc = (s) => String(s).replace(/'/g, "''");
    const types = list(args['ado-types']).length ? list(args['ado-types']) : ['User Story', 'Product Backlog Item', 'Bug', 'Feature'];
    ids.push(...await A.wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.IterationPath] UNDER '${esc(args['ado-iteration'])}'` +
      `${args['ado-area'] ? ` AND [System.AreaPath] UNDER '${esc(args['ado-area'])}'` : ''} AND [System.WorkItemType] IN (${types.map((t) => `'${esc(t)}'`).join(',')})` +
      ` AND [System.State] <> 'Removed'`));
    inputs.adoIteration = args['ado-iteration'];
  }
  if (args['ado-query']) {
    const r = await A.api('GET', `${A.ORG}/${A.PROJ}/_apis/wit/wiql/${args['ado-query']}?${A.V}`);
    ids.push(...(r.workItems || []).map((w) => w.id));
    inputs.adoQuery = args['ado-query'];
  }
  ids = [...new Set(ids)];
  if (ids.length) {
    inputs.adoItems = ids.length;
    const items = await A.getWorkItems(ids, { relations: true });
    for (const w of items) {
      const item = { id: w.id, type: w.fields['System.WorkItemType'], title: w.fields['System.Title'], areaPath: w.fields['System.AreaPath'],
        tags: (w.fields['System.Tags'] || '').split(';').map((t) => t.trim()).filter(Boolean) };
      const mods = modulesForItem(item);
      mods.forEach((mm) => hit(mm, `ADO ${item.type} ${item.id}`));
      const { prs, commits } = A.gitLinks(w.relations);
      let viaCode = 0;
      for (const pr of prs) {
        try {
          const r = await A.repo(pr.repoId);
          const files = await A.prFiles(pr.repoId, pr.prId);
          const before = reasons.size;
          await appChange(r.name, files, `PR ${r.name}!${pr.prId} (ADO ${item.id})`);
          viaCode += files.length && reasons.size >= before ? 1 : 0;
        } catch (e) { unmapped.appFiles.push(`PR ${pr.repoId}!${pr.prId}: ${e.message.slice(0, 120)}`); }
      }
      for (const c of commits) {
        try {
          const r = await A.repo(c.repoId);
          await appChange(r.name, await A.commitFiles(c.repoId, c.commitId), `commit ${r.name}@${c.commitId.slice(0, 8)} (ADO ${item.id})`);
          viaCode++;
        } catch (e) { unmapped.appFiles.push(`commit ${c.repoId}@${c.commitId.slice(0, 8)}: ${e.message.slice(0, 120)}`); }
      }
      if (!mods.length && !viaCode) unmapped.adoItems.push(item);
    }
  }
  for (const spec of list(args['app-pr'])) {
    const [repo, pr] = spec.split(':');
    (inputs.appPrs ??= []).push(spec);
    await appChange(repo, await A.prFiles(repo, Number(pr)), `PR ${repo}!${pr}`);
  }
  for (const spec of list(args['app-commit'])) {
    const [repo, sha] = spec.split(':');
    (inputs.appCommits ??= []).push(spec);
    await appChange(repo, await A.commitFiles(repo, sha), `commit ${repo}@${sha.slice(0, 8)}`);
  }
}

// ---------- 3. local diff (this repo) ----------
const cat = loadCatalog(cfg);
const useLocal = args.base !== undefined || (!wantsAdo && !args.modules);
if (useLocal) {
  const base = args.base && args.base !== true ? args.base : cfg.regression?.baseBranch || 'main';
  const run = (c) => execSync(c, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  let changed = [];
  try {
    const mb = run(`git merge-base ${base} HEAD`).trim();
    changed = [...run(`git diff --name-only ${mb} HEAD`).split(/\r?\n/), ...run('git diff --name-only HEAD').split(/\r?\n/)];
  } catch (e) {
    fail(`git diff against "${base}" failed: ${e.stderr?.toString().trim() || e.message}`);
  }
  changed = [...new Set(changed.filter(Boolean))];
  inputs.localBase = base;
  inputs.localChangedFiles = changed.length;
  const testsByFile = new Map();
  for (const t of cat.tests) (testsByFile.get(t.file) || testsByFile.set(t.file, []).get(t.file)).push(t.id);
  for (const f of changed) {
    if (testsByFile.has(f)) { testsByFile.get(f).forEach((id) => directTests.add(id)); continue; }
    if (sharedPaths.some((g) => matchGlob(g, f))) { broadImpact.push(f); continue; }
    const appMods = Object.entries(modules).filter(([, m]) => (m.paths || []).some((g) => matchGlob(g, f))).map(([k]) => k);
    const testMods = Object.entries(modules).filter(([, m]) => (m.testPaths || []).some((g) => matchGlob(g, f))).map(([k]) => k);
    appMods.forEach((mm) => hit(mm, `app code changed: ${f}`));
    testMods.forEach((mm) => hit(mm, `test support code changed: ${f}`));
    const mods = [...appMods, ...testMods];
    if (mods.length) { /* recorded above */ }
    else if (!/\.(md|txt|png|jpe?g|svg|gif)$|^\.qa\/|^\.claude\//i.test(f)) unmapped.localFiles.push(f);
  }
}

// ---------- 4. transitive impact (bounded) ----------
const maxDepth = Number(args['max-depth'] ?? cfg.regression?.maxDepth ?? 1);
const depthOf = new Map([...reasons.keys()].map((k) => [k, 0]));
let frontier = [...reasons.keys()];
for (let d = 1; d <= maxDepth && frontier.length; d++) {
  const next = [];
  for (const [k, m] of Object.entries(modules)) {
    if (depthOf.has(k)) continue;
    const dep = (m.dependsOn || []).find((x) => frontier.includes(x));
    if (dep) { depthOf.set(k, d); hit(k, `depends on ${dep} (hop ${d})`); next.push(k); }
  }
  frontier = next;
}
const impacted = new Set(reasons.keys());
const journeys = new Set([...impacted].flatMap((k) => modules[k]?.journeys || []));

// ---------- 5. selection ----------
const always = cfg.regression?.alwaysInclude || { tags: ['smoke'], priorities: [] };
const alwaysTags = (always.tags || []).map((t) => t.toLowerCase());
const tests = cat.tests.filter((t) => t.enabled !== false && (impacted.has(t.module) || directTests.has(t.id) ||
  t.groups.some((g) => alwaysTags.includes(g.toLowerCase()))));
const cases = loadCases(cfg).filter(({ case: c }) => c?.id && (impacted.has(c.module) || (c.journey && journeys.has(c.journey)) ||
  (c.tags || []).some((t) => alwaysTags.includes(t.toLowerCase())) || (always.priorities || []).includes(c.priority))).map(({ case: c }) => c.id);

const totalModules = Object.keys(modules).length;
const ratio = totalModules ? impacted.size / totalModules : 0;
const recommendation = [
  !totalModules && 'No module map. Run build-module-map.mjs, then fill areaPaths/appRepos.',
  broadImpact.length && `${broadImpact.length} change(s) in shared framework code (sharedPaths). Consider the full tier.`,
  ratio > 0.3 && `${impacted.size}/${totalModules} components impacted (${Math.round(ratio * 100)}%). A full run may be simpler.`,
  unmapped.adoItems.length && `${unmapped.adoItems.length} ADO item(s) matched no component. Add areaPaths/adoTags or link PRs.`,
  unmapped.appFiles.length && `${unmapped.appFiles.length} app file(s) matched no component. Add appRepos paths.`,
  unmapped.localFiles.length && `${unmapped.localFiles.length} local file(s) matched no component.`,
].filter(Boolean);

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const outFile = path.resolve(root, args.out && args.out !== true ? args.out : `.qa/selections/${stamp}.json`);
const impactedList = [...impacted].map((m) => ({ module: m, depth: depthOf.get(m) ?? 0, reasons: [...reasons.get(m)] }))
  .sort((a, b) => a.depth - b.depth || a.module.localeCompare(b.module));
writeJson(outFile, { generatedAt: new Date().toISOString(), inputs, maxDepth, catalogCommit: cat.commit, impactedModules: impactedList,
  broadImpact, unmapped, recommendation, counts: { tests: tests.length, cases: cases.length }, tests: tests.map((t) => t.id), cases });

const countBy = (xs, f) => xs.reduce((o, x) => { const k = f(x) ?? '(none)'; o[k] = (o[k] || 0) + 1; return o; }, {});
const cap = (a, n) => (a.length > n ? [...a.slice(0, n), `… +${a.length - n} more (see selection file)`] : a);
out({
  selectionFile: path.relative(root, outFile).split(path.sep).join('/'),
  inputs,
  moduleMaps: sources.map((f) => path.relative(root, f).split(path.sep).join('/')),
  impacted: `${impacted.size}/${totalModules} components`,
  impactedModules: cap(impactedList.map((m) => `${m.module}${m.depth ? ` (hop ${m.depth})` : ''}: ${m.reasons.slice(0, 2).join('; ')}${m.reasons.length > 2 ? ` +${m.reasons.length - 2}` : ''}`), 40),
  selected: { tests: tests.length, cases: cases.length, directlyChangedTests: directTests.size },
  testsByModule: Object.entries(countBy(tests, (t) => t.module)).sort((a, b) => b[1] - a[1]).slice(0, 20),
  testsByAppType: countBy(tests, (t) => t.appType),
  broadImpact: cap(broadImpact, 10),
  unmapped: {
    adoItems: cap(unmapped.adoItems.map((i) => `${i.id} [${i.type}] ${i.title} (${i.areaPath})`), 15),
    appFiles: cap(unmapped.appFiles, 15),
    localFiles: cap(unmapped.localFiles, 15),
  },
  recommendation: recommendation.length ? recommendation : ['Selection looks well-mapped.'],
});
