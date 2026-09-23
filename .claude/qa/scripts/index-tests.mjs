#!/usr/bin/env node
// Builds or searches the test catalog (.qa/catalog.json) of existing automated tests.
// Usage:
//   node .claude/qa/scripts/index-tests.mjs                          # rebuild + print summary
//   node .claude/qa/scripts/index-tests.mjs --search "refund" [--module payments] [--group smoke]
//        [--app web|api] [--kind testng|junit5|junit4|cucumber] [--file <glob>] [--limit 30]
// Search matches id/title/groups/file (all words must match, case-insensitive). Output is always bounded.
import { loadConfig, parseArgs, matchGlob, out } from './lib/common.mjs';
import { buildCatalog, writeCatalog, loadCatalog, CATALOG_FILE } from './lib/catalog.mjs';

const args = parseArgs();
const cfg = loadConfig({ required: false }) || { packs: [], paths: {} };
const top = (obj, n = 15) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
const countBy = (xs, f) => xs.reduce((o, x) => { const k = f(x) ?? '(none)'; o[k] = (o[k] || 0) + 1; return o; }, {});

const searching = ['search', 'module', 'group', 'app', 'kind', 'file'].some((k) => args[k] !== undefined);

if (!searching) {
  const cat = buildCatalog(cfg);
  const file = writeCatalog(cat);
  const byModule = countBy(cat.tests, (t) => t.module);
  out({
    catalog: CATALOG_FILE,
    commit: cat.commit,
    counts: cat.counts,
    modules: Object.keys(byModule).length,
    byDriver: countBy(cat.tests, (t) => t.driver),
    byKind: countBy(cat.tests, (t) => t.kind),
    byAppType: countBy(cat.tests, (t) => t.appType),
    disabled: cat.tests.filter((t) => t.enabled === false).length,
    withAdoIds: cat.tests.filter((t) => t.adoIds?.length).length,
    topModules: top(byModule, 20),
    topGroups: top(countBy(cat.tests.flatMap((t) => t.groups.map((g) => ({ g }))), (x) => x.g), 20),
    hint: cat.counts.unassigned
      ? `${cat.counts.unassigned} tests have no module. Run build-module-map.mjs, or add testPaths in .qa/module-map.json.`
      : undefined,
  });
} else {
  const cat = loadCatalog(cfg);
  const words = String(args.search || '').toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Number(args.limit || 30);
  const hits = cat.tests.filter((t) => {
    if (args.module && t.module !== args.module) return false;
    if (args.group && !t.groups.some((g) => g.toLowerCase() === String(args.group).toLowerCase())) return false;
    if (args.app && t.appType !== args.app) return false;
    if (args.kind && t.kind !== args.kind) return false;
    if (args.file && !matchGlob(String(args.file), t.file)) return false;
    const hay = `${t.id} ${t.title} ${t.groups.join(' ')} ${t.file}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  out({
    total: hits.length,
    shown: Math.min(limit, hits.length),
    rebuilt: Boolean(cat.rebuilt),
    tests: hits.slice(0, limit).map(({ id, title, module, groups, appType, file, enabled }) =>
      ({ id, title, module, groups, appType, file, ...(enabled === false ? { enabled } : {}) })),
    ...(hits.length > limit ? { note: `Showing ${limit} of ${hits.length}. Narrow with --module/--group/--app or more words.` } : {}),
  });
}
