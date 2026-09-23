// Java driver: TestNG, JUnit 4, JUnit 5 (+ Allure annotations). Build units: Maven / Gradle modules.
import fs from 'node:fs';
import path from 'node:path';
import { splitTop, uniq, humanize, adoIdsIn, shq } from '../scan.mjs';

const LIFECYCLE = new Set(['BeforeMethod', 'AfterMethod', 'BeforeClass', 'AfterClass', 'BeforeSuite', 'AfterSuite', 'BeforeTest',
  'AfterTest', 'BeforeGroups', 'AfterGroups', 'DataProvider', 'Factory', 'BeforeEach', 'AfterEach', 'BeforeAll', 'AfterAll',
  'Before', 'After', 'Parameters', 'Ignore', 'Disabled']);

function parseValue(v) {
  v = v.trim();
  if (v.startsWith('{')) return splitTop(v.slice(1, -1)).map(parseValue).flat();
  const strs = [...v.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  if (strs.length) return strs.join('');
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  return v.split('.').pop();
}
function parseAnnArgs(argText) {
  const out = {};
  if (!argText || !argText.trim()) return out;
  for (const part of splitTop(argText)) {
    const m = part.match(/^\s*(\w+)\s*=\s*([\s\S]+)$/);
    if (m) out[m[1]] = parseValue(m[2]);
    else out.value = parseValue(part);
  }
  return out;
}
function balanced(text, i) {
  let depth = 0, quote = null;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (quote) { if (c === '\\') j++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return [text.slice(i + 1, j), j + 1];
  }
  return [text.slice(i + 1), text.length];
}
const arr = (v) => (v === undefined ? [] : [].concat(v)).map(String).filter(Boolean);

function detectAppType(text, fqcn) {
  if (/import\s+(org\.openqa\.selenium|com\.codeborne\.selenide|com\.microsoft\.playwright|io\.appium)/.test(text)) return 'web';
  if (/import\s+(static\s+)?(io\.restassured|org\.apache\.http|okhttp3|retrofit2|java\.net\.http|org\.springframework\.web\.client|com\.intuit\.karate)/.test(text)) return 'api';
  if (/(^|\.)(api|rest|service|contract)s?(\.|$)|Api(Test|IT|Tests)?$/i.test(fqcn)) return 'api';
  if (/(^|\.)(ui|web|e2e|pages?|selenium)(\.|$)|(Ui|Web|Page|E2e)(Test|IT|Tests)?$/i.test(fqcn)) return 'web';
  return null;
}

export function parseJava(text, rel) {
  if (!text.includes('@Test')) return [];
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
  const pkg = (src.match(/^\s*package\s+([\w.]+)\s*;/m) || [])[1] || '';
  const framework = /import\s+org\.testng/.test(src) ? 'testng' : /import\s+org\.junit\.jupiter/.test(src) ? 'junit5' : /import\s+org\.junit\./.test(src) ? 'junit4' : 'testng';
  const tests = [];
  let pending = [];
  let className = null, classAnn = [], abstract = false, depth = 0, classDepth = -1;
  // Text blocks and string/char literals are matched first so braces inside them (JSON payloads) are ignored.
  const re = /"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|@((?:\w+\.)*\w+)|\b(class|interface|enum|record)\s+(\w+)|\bvoid\s+(\w+)\s*\(|[;{}]/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[0][0] === '"' || m[0][0] === "'") continue;
    if (m[1]) {
      let args = '';
      let k = re.lastIndex;
      while (/\s/.test(src[k] || '')) k++;
      if (src[k] === '(') { const [inner, end] = balanced(src, k); args = inner; re.lastIndex = end; }
      pending.push({ name: m[1].split('.').pop(), args: parseAnnArgs(args) });
      continue;
    }
    if (m[2]) {
      if (className === null && m[2] === 'class') {
        className = m[3];
        classAnn = pending;
        abstract = /\babstract\s+(?:\w+\s+)*$/.test(src.slice(Math.max(0, m.index - 60), m.index));
        classDepth = depth;
      }
      pending = [];
      continue;
    }
    if (m[4]) {
      const names = pending.map((a) => a.name);
      const methodTest = pending.find((a) => a.name === 'Test');
      const classTest = classAnn.find((a) => a.name === 'Test');
      const decl = src.slice(Math.max(0, m.index - 80), m.index);
      const isPublic = /\bpublic\s+(?:static\s+|final\s+|synchronized\s+)*$/.test(decl);
      if (className && depth === classDepth + 1 && (methodTest || (classTest && isPublic && !names.some((n) => LIFECYCLE.has(n))))) {
        const a = { ...(classTest?.args || {}), ...(methodTest?.args || {}) };
        const annVal = (n, key = 'value') => pending.find((x) => x.name === n)?.args[key];
        const method = m[4];
        const fqcn = pkg ? `${pkg}.${className}` : className;
        const groups = uniq([...arr(classTest?.args.groups), ...arr(methodTest?.args.groups),
          ...classAnn.filter((x) => x.name === 'Tag').map((x) => String(x.args.value)),
          ...pending.filter((x) => x.name === 'Tag').map((x) => String(x.args.value))]);
        const adoIds = uniq([...pending.filter((x) => /^(TmsLink|WorkItem|TestCaseId|TestCase|AdoId)$/.test(x.name)).flatMap((x) => arr(x.args.value)),
          ...adoIdsIn(method, a.description)]);
        tests.push({
          id: `${fqcn}#${method}`, kind: framework, file: rel, line: src.slice(0, m.index).split('\n').length, class: fqcn, method,
          title: a.description || annVal('DisplayName') || annVal('Description') || humanize(method),
          groups,
          ...(a.priority !== undefined ? { priority: a.priority } : {}),
          ...(a.enabled === false || names.includes('Disabled') || names.includes('Ignore') ? { enabled: false } : {}),
          ...(a.dataProvider ? { dataProvider: String(a.dataProvider) } : {}),
          ...(a.dependsOnMethods ? { dependsOn: arr(a.dependsOnMethods) } : {}),
          ...(adoIds.length ? { adoIds } : {}),
          appType: detectAppType(src, fqcn),
        });
      }
      pending = [];
      continue;
    }
    if (m[0] === '{') depth++;
    else if (m[0] === '}') depth--;
    pending = [];
  }
  return abstract ? [] : tests;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export default {
  id: 'java',
  label: 'Java (TestNG / JUnit 4 / JUnit 5)',
  markers: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  classify: (rel) => (rel.endsWith('.java') ? 'maybe' : null),
  parse: parseJava,
  junitKeys: (t) => [`${t.class}#${t.method}`],
  /** One TestNG suite (TestNG tests) and/or a -Dtest / --tests filter (JUnit, Gradle) per build unit. */
  suite({ unit, unitMarkers, tests, outDir, safe, runner, root }) {
    const files = [], commands = [];
    const gradle = !unitMarkers.includes('pom.xml') && unitMarkers.some((m) => m.startsWith('build.gradle'));
    const pl = unit === '.' ? '' : `-pl ${unit}`;
    if (gradle) {
      const wrapper = fs.existsSync(path.join(root, 'gradlew')) ? './gradlew' : 'gradle';
      const project = unit === '.' ? '' : ':' + unit.split('/').join(':');
      const filters = tests.map((t) => `--tests ${shq(`${t.class}.${t.method}`)}`).join(' ');
      commands.push({ command: (runner.commands?.gradle || `${wrapper} {project}:test {filters}`).replace('{project}', () => project).replace('{filters}', () => filters) });
      return { files, commands };
    }
    const testng = tests.filter((t) => t.kind === 'testng');
    const junit = tests.filter((t) => t.kind !== 'testng');
    if (testng.length) {
      const byClass = new Map();
      for (const t of testng) { if (!byClass.has(t.class)) byClass.set(t.class, new Set()); byClass.get(t.class).add(t.method); }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">\n` +
        `<suite name="qa-${esc(safe)}" verbose="1">\n  <test name="qa-selection">\n    <classes>\n` +
        [...byClass.entries()].map(([cls, ms]) => `      <class name="${esc(cls)}">\n        <methods>\n` +
          [...ms].map((mm) => `          <include name="${esc(mm)}"/>`).join('\n') + '\n        </methods>\n      </class>').join('\n') +
        `\n    </classes>\n  </test>\n</suite>\n`;
      const file = path.join(outDir, `testng-${safe}.xml`);
      files.push({ path: file, content: xml });
      const template = runner.commands?.testng || runner.command || 'mvn -q {pl} test -Dsurefire.suiteXmlFiles={suiteXml} -DfailIfNoTests=false -Dsurefire.failIfNoSpecifiedTests=false';
      commands.push({ command: template.replace('{pl}', () => pl).replace('{module}', () => unit).replace('{suiteXml}', () => file.split(path.sep).join('/')) });
    }
    if (junit.length) {
      const byClass = new Map();
      for (const t of junit) { if (!byClass.has(t.class)) byClass.set(t.class, []); byClass.get(t.class).push(t.method); }
      const filter = [...byClass.entries()].map(([c, ms]) => `${c}#${[...new Set(ms)].join('+')}`).join(',');
      const template = runner.commands?.junit || 'mvn -q {pl} test -Dtest={tests} -DfailIfNoTests=false -Dsurefire.failIfNoSpecifiedTests=false';
      commands.push({ command: template.replace('{pl}', () => pl).replace('{module}', () => unit).replace('{tests}', () => shq(filter)),
        ...(filter.length > 6000 ? { note: 'Long -Dtest filter; consider running whole classes or splitting.' } : {}) });
    }
    return { files, commands };
  },
  defaultReports: ['**/target/surefire-reports/testng-results.xml', '**/target/surefire-reports/TEST-*.xml',
    '**/target/failsafe-reports/TEST-*.xml', '**/build/test-results/**/TEST-*.xml'],
};
