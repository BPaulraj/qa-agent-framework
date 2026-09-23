// Python driver: pytest (functions, Test* classes, marks) and unittest.TestCase. Build units: Python project dirs.
import path from 'node:path';
import { uniq, humanize, adoIdsIn, shq, chunkBy } from '../scan.mjs';

const NON_GROUP_MARKS = new Set(['parametrize', 'usefixtures', 'filterwarnings', 'timeout', 'order', 'dependency', 'flaky',
  'asyncio', 'django_db', 'skipif', 'skip', 'xfail', 'run', 'tryfirst', 'trylast']);

const marksIn = (s) => [...String(s).matchAll(/\bpytest\.mark\.(\w+)/g)].map((m) => m[1]);

export function parsePython(text, rel) {
  if (!/\bdef\s+test/.test(text)) return [];
  const lines = text.split(/\r?\n/);
  const tests = [];
  const classes = [];                    // { name, indent, marks, isTest, skip }
  let pending = [];                      // decorator texts
  let moduleMarks = [];
  const pm = text.match(/^pytestmark\s*=\s*([\s\S]*?)(?:\n\S|$)/m);
  if (pm) moduleMarks = marksIn(pm[1]);
  const moduleSkip = moduleMarks.includes('skip');
  const imports = text.slice(0, 4000);
  const appType = /^\s*(from|import)\s+(playwright|selenium|splinter|pytest_playwright|seleniumbase)/m.test(imports) ? 'web'
    : /^\s*(from|import)\s+(requests|httpx|aiohttp|grpc|tavern|schemathesis)/m.test(imports) ? 'api'
      : /(^|\/)(api|rest|contract|services?)(\/|_)/i.test(rel) ? 'api' : /(^|\/)(e2e|ui|web|pages?)(\/|_)/i.test(rel) ? 'web' : null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    while (classes.length && indent <= classes.at(-1).indent && !line.trim().startsWith('@')) classes.pop();
    let m;
    if ((m = line.match(/^\s*@(.+)$/))) {
      let deco = m[1];
      let depth = (deco.match(/\(/g) || []).length - (deco.match(/\)/g) || []).length;
      while (depth > 0 && i + 1 < lines.length) { i++; deco += ' ' + lines[i].trim(); depth += (lines[i].match(/\(/g) || []).length - (lines[i].match(/\)/g) || []).length; }
      pending.push(deco);
      continue;
    }
    if ((m = line.match(/^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/))) {
      const bases = m[3] || '';
      const marks = pending.flatMap(marksIn);
      classes.push({ name: m[2], indent, marks, isTest: /^Test/.test(m[2]) || /TestCase\b/.test(bases),
        unittest: /TestCase\b/.test(bases), skip: marks.includes('skip') || pending.some((d) => /^unittest\.skip\b/.test(d)) });
      pending = [];
      continue;
    }
    if ((m = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)?/))) {
      const name = m[2];
      const cls = classes.filter((c) => indent > c.indent);
      const inClass = cls.length > 0;
      const isTest = name.startsWith('test') && (!inClass || cls.every((c) => c.isTest));
      if (isTest) {
        const marks = uniq([...moduleMarks, ...cls.flatMap((c) => c.marks), ...pending.flatMap(marksIn)]);
        let doc = null;
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          const d = lines[j].trim().match(/^(?:[rbuRBU]{0,2})("""|''')\s*(.+?)(?:\1)?$/);
          if (d) { doc = d[2].replace(/("""|''')$/, '').trim(); break; }
          if (lines[j].trim()) break;
        }
        const chain = cls.map((c) => c.name);
        const skip = moduleSkip || cls.some((c) => c.skip) || marks.includes('skip') || pending.some((d) => /^unittest\.skip\b/.test(d));
        const params = m[3] || '';
        const groups = marks.filter((x) => !NON_GROUP_MARKS.has(x)).concat(marks.includes('xfail') ? ['xfail'] : []);
        const adoIds = adoIdsIn(name, doc, groups.join(' '), pending.join(' '));
        tests.push({
          id: [rel, ...chain, name].join('::'), kind: cls.some((c) => c.unittest) ? 'unittest' : 'pytest', file: rel, line: i + 1,
          class: chain.join('.') || undefined, method: name,
          title: doc || humanize(name), groups: uniq(groups),
          ...(skip ? { enabled: false } : {}),
          ...(pending.some((d) => /pytest\.mark\.parametrize/.test(d)) ? { parametrized: true } : {}),
          ...(adoIds.length ? { adoIds } : {}),
          appType: /\bpage\b/.test(params) ? 'web' : appType,
        });
      }
      pending = [];
      continue;
    }
    pending = [];
  }
  return tests;
}

const dotted = (f) => f.replace(/\.py$/, '').split('/').join('.');

export default {
  id: 'python',
  label: 'Python (pytest / unittest)',
  markers: ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'setup.py', 'requirements.txt'],
  classify(rel) {
    if (!rel.endsWith('.py') || /(^|\/)(\.venv|venv|site-packages|__pycache__)\//.test(rel)) return null;
    return /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(rel) ? 'test' : 'source';
  },
  parse: parsePython,
  junitKeys(t, { unit }) {
    const fromUnit = unit && unit !== '.' ? path.posix.relative(unit, t.file) : t.file;
    const cls = t.class ? `.${t.class}` : '';
    return uniq([`${dotted(fromUnit)}${cls}#${t.method}`, `${dotted(t.file)}${cls}#${t.method}`, `${path.posix.basename(t.file, '.py')}${cls}#${t.method}`]);
  },
  suite({ unit, tests, outDir, safe, runner }) {
    const cd = unit === '.' ? '' : `cd ${shq(unit)} && `;
    const nodeid = (t) => (unit === '.' ? t.id : path.posix.relative(unit, t.file) + t.id.slice(t.file.length));
    const commands = chunkBy(tests.map((t) => shq(nodeid(t))), 6000).map((ids, i) => ({ command:
      (runner.commands?.pytest || '{cd}python -m pytest {nodeids} --junitxml={report} -q')
        .replace('{cd}', () => cd).replace('{nodeids}', () => ids.join(' ')).replace('{report}', () => `{reportDir}/pytest-${safe}-${i + 1}.xml`) }));
    return { files: [{ path: path.join(outDir, `pytest-${safe}.txt`), content: tests.map(nodeid).join('\n') + '\n' }], commands };
  },
  defaultReports: ['**/junit*.xml', '**/test-results/**/*.xml'],
};
