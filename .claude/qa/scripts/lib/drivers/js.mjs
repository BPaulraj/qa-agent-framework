// JS/TS driver: Playwright Test, Jest, Vitest, Cypress, Mocha. Build units: package.json directories.
import fs from 'node:fs';
import path from 'node:path';
import { stripComments, matchBracket, skipString, readStringAt, lineAt, uniq, adoIdsIn, dedupeIds, shq, reEsc, chunkBy } from '../scan.mjs';

const CALL = /(describe|context|suite|test|it|specify|xit|xtest|xdescribe|xcontext|fit|fdescribe)((?:\s*\.\s*\w+)*)\s*\(/y;
const NOT_BLOCKS = /\b(configure|use|extend|step|info|setTimeout|slow|beforeEach|afterEach|beforeAll|afterAll|expect|fail\.only|todo)\b/;

function frameworkOf(text, rel) {
  if (/from\s+['"]@playwright\/test['"]|require\(\s*['"]@playwright\/test['"]\s*\)/.test(text)) return 'playwright';
  if (/from\s+['"]vitest['"]/.test(text)) return 'vitest';
  if (/\.cy\.[cm]?[jt]sx?$/.test(rel) || /\bcy\.(visit|get|request|intercept)\(/.test(text)) return 'cypress';
  if (/from\s+['"]mocha['"]|require\(\s*['"]mocha['"]\s*\)/.test(text)) return 'mocha';
  if (/from\s+['"]@jest\/globals['"]/.test(text)) return 'jest';
  return 'js';   // resolved from the unit's package.json at suite time
}

function appTypeOf(text, rel, argsText, framework) {
  if (framework === 'playwright') {
    const params = (argsText.match(/async\s*\(\s*\{([^}]*)\}/) || [])[1] || '';
    if (/\bpage\b|\bcontext\b|\bbrowser\b/.test(params)) return 'web';
    if (/\brequest\b/.test(params)) return 'api';
  }
  if (framework === 'cypress') return /\bcy\.visit\(/.test(text) || !/\bcy\.request\(/.test(text) ? 'web' : 'api';
  if (/from\s+['"](supertest|axios|got|node-fetch|undici|pactum|frisby)['"]/.test(text)) return 'api';
  if (/from\s+['"](selenium-webdriver|webdriverio|puppeteer)['"]/.test(text)) return 'web';
  if (/(^|\/)(api|rest|contract|services?)(\/|\.)/i.test(rel)) return 'api';
  if (/(^|\/)(e2e|ui|web|pages?)(\/|\.)/i.test(rel)) return 'web';
  return null;
}

const tagsIn = (argsHead, title) => uniq([
  ...[...argsHead.matchAll(/\btags?\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/g)].flatMap((m) => [...m[1].matchAll(/['"`]@?([^'"`]+)['"`]/g)].map((x) => x[1])),
  ...[...String(title).matchAll(/(?:^|\s)@([\w:-]+)/g)].map((m) => m[1]),
]);

export function parseJs(text, rel) {
  if (!/\b(test|it|specify)\s*(\.\s*\w+\s*)*\(/.test(text)) return [];
  const src = stripComments(text);
  const framework = frameworkOf(src, rel);
  const blocks = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i) - 1; continue; }
    if (!/[a-z]/.test(c) || /[\w$.]/.test(src[i - 1] || '')) continue;
    CALL.lastIndex = i;
    const m = CALL.exec(src);
    if (!m) continue;
    const mods = m[2].replace(/\s/g, '');
    if (NOT_BLOCKS.test(mods)) continue;
    let p = CALL.lastIndex - 1;                              // index of '('
    if (/\.each$/.test(mods)) {                               // it.each(table)('title %s', fn)
      let q = matchBracket(src, p);
      while (/\s/.test(src[q] || '')) q++;
      if (src[q] !== '(') continue;
      p = q;
    }
    const title = readStringAt(src, p + 1);
    if (!title) continue;
    const end = matchBracket(src, p);
    const argsText = src.slice(p + 1, end - 1);
    // Callback body: the first `=> {` or `function (...) {`. (Not the `{ page }` destructuring before `=>`.)
    const fm = argsText.match(/=>\s*\{|function\s*\w*\s*\([^)]*\)\s*\{/);
    if (!fm && !/=>/.test(argsText)) continue;                 // a declaration needs a callback
    const fnIdx = fm ? fm.index : argsText.indexOf('=>');
    const bodyStart = fm ? p + 1 + fm.index + fm[0].length - 1 : -1;
    const isDescribe = /describe|context|suite/.test(m[1]) || /(^|\.)describe/.test(mods);
    blocks.push({
      type: isDescribe ? 'describe' : 'test',
      title: title.value,
      start: i,
      bodyStart,
      bodyEnd: bodyStart >= 0 ? matchBracket(src, bodyStart) : end,
      skip: /^x/.test(m[1]) || /\.(skip|fixme|todo)\b/.test(mods + '.'),
      tags: tagsIn(argsText.slice(0, fnIdx >= 0 ? fnIdx : argsText.length), title.value),
      argsText,
    });
    i = p;                                                     // keep scanning inside the call (nested blocks)
  }
  const describes = blocks.filter((b) => b.type === 'describe');
  const tests = blocks.filter((b) => b.type === 'test').map((t) => {
    const anc = describes.filter((d) => d.bodyStart >= 0 && d.bodyStart < t.start && t.start < d.bodyEnd).sort((a, b) => a.bodyStart - b.bodyStart);
    const titlePath = [...anc.map((d) => d.title), t.title];
    const groups = uniq([...anc.flatMap((d) => d.tags), ...t.tags]);
    const adoIds = adoIdsIn(titlePath.join(' '), groups.join(' '));
    return {
      id: `${rel}#${titlePath.join(' > ')}`, kind: framework, file: rel, line: lineAt(src, t.start),
      title: t.title, titlePath, groups,
      ...(t.skip || anc.some((d) => d.skip) ? { enabled: false } : {}),
      ...(adoIds.length ? { adoIds } : {}),
      appType: appTypeOf(src, rel, t.argsText, framework),
    };
  });
  return dedupeIds(tests);
}

function unitFramework(root, unit, kind) {
  if (kind !== 'js') return kind;
  let deps = {};
  try { const pj = JSON.parse(fs.readFileSync(path.join(root, unit, 'package.json'), 'utf8')); deps = { ...pj.dependencies, ...pj.devDependencies }; } catch { /* none */ }
  return deps.vitest ? 'vitest' : deps.jest ? 'jest' : deps.mocha ? 'mocha' : deps['@playwright/test'] ? 'playwright' : 'jest';
}

export default {
  id: 'js',
  label: 'JavaScript / TypeScript (Playwright, Jest, Vitest, Cypress, Mocha)',
  markers: ['package.json'],
  classify(rel) {
    if (/\.d\.ts$/.test(rel) || /(^|\/)(node_modules|dist|build|coverage)\//.test(rel)) return null;
    if (/\.(spec|test|cy|e2e)\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)__tests__\/.+\.[cm]?[jt]sx?$/.test(rel)) return 'test';
    return /\.[cm]?[jt]sx?$/.test(rel) ? 'source' : null;
  },
  parse: parseJs,
  junitKeys(t, { unit }) {
    const tp = t.titlePath || [t.title];
    const fromUnit = unit && unit !== '.' ? path.posix.relative(unit, t.file) : t.file;
    return uniq([
      `#${tp.join(' › ')}`, `#${tp.join(' > ')}`, `#${tp.join(' ')}`,
      `${t.file}#${tp.join(' › ')}`, `${fromUnit}#${tp.join(' › ')}`, `${path.posix.basename(t.file)}#${tp.join(' › ')}`,
      `${tp.slice(0, -1).join(' ')}#${t.title}`, `${tp.join(' ')}#${tp.join(' ')}`,
    ]);
  },
  suite({ unit, tests, outDir, safe, runner, root }) {
    const cd = unit === '.' ? '' : `cd ${shq(unit)} && `;
    const rel = (f) => (unit === '.' ? f : path.posix.relative(unit, f));
    const byFw = new Map();
    for (const t of tests) { const fw = unitFramework(root, unit, t.kind); if (!byFw.has(fw)) byFw.set(fw, []); byFw.get(fw).push(t); }
    const commands = [];
    const tpl = (fw, def) => runner.commands?.[fw] || def;
    for (const [fw, ts] of byFw) {
      const fullName = (t) => (t.titlePath || [t.title]).join(' ');
      if (fw === 'playwright') {
        chunkBy(ts.map((t) => shq(`${rel(t.file)}:${t.line}`)), 6000).forEach((locs, i) => commands.push({ command:
          tpl('playwright', '{cd}PLAYWRIGHT_JUNIT_OUTPUT_FILE={report} npx playwright test {locations} --reporter=junit,line')
            .replace('{cd}', () => cd).replace('{report}', () => `{reportDir}/playwright-${safe}-${i + 1}.xml`).replace('{locations}', () => locs.join(' ')) }));
      } else if (fw === 'cypress') {
        const specs = uniq(ts.map((t) => rel(t.file)));
        chunkBy(specs, 6000, ',').forEach((sp, i) => commands.push({ command:
          tpl('cypress', '{cd}npx cypress run --spec {specs} --reporter junit --reporter-options mochaFile={report}')
            .replace('{cd}', () => cd).replace('{specs}', () => shq(sp.join(','))).replace('{report}', () => `{reportDir}/cypress-${safe}-${i + 1}-[hash].xml`),
          note: 'Runs whole spec files. With @cypress/grep installed, add --env grep="<title1>;<title2>" to narrow to tests.' }));
      } else {
        // jest / vitest / mocha: files + full-title regex
        const groups = chunkBy(ts, 5000, null, (t) => reEsc(fullName(t)).length + rel(t.file).length + 4);
        groups.forEach((g, i) => {
          const files = uniq(g.map((t) => shq(rel(t.file)))).join(' ');
          const regex = shq(`^(${uniq(g.map((t) => reEsc(fullName(t)))).join('|')})$`);
          const report = `{reportDir}/${fw}-${safe}-${i + 1}`;
          const def = fw === 'vitest' ? '{cd}npx vitest run {files} -t {regex} --reporter=junit --outputFile={report}.xml'
            : fw === 'mocha' ? '{cd}npx mocha {files} --grep {regex} --reporter xunit --reporter-option output={report}.xml'
              : '{cd}npx jest {files} -t {regex} --json --outputFile={report}.json';
          commands.push({ command: tpl(fw, def).replace('{cd}', () => cd).replace('{files}', () => files).replace('{regex}', () => regex).replace(/\{report\}/g, () => report) });
        });
      }
    }
    return { files: [{ path: path.join(outDir, `js-${safe}.txt`), content: tests.map((t) => t.id).join('\n') + '\n' }], commands };
  },
  defaultReports: ['**/test-results/**/*.xml', '**/junit*.xml'],
};
