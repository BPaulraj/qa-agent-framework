// .NET driver: NUnit, xUnit, MSTest (C#). Build units: *.csproj directories. Results: TRX (built-in logger) or JUnit XML.
import path from 'node:path';
import { stripComments, splitTop, uniq, humanize, adoIdsIn, shq, chunkBy } from '../scan.mjs';

const TEST_ATTRS = /^(Test|TestCase|TestCaseSource|Fact|Theory|TestMethod|DataTestMethod)$/;

function parseAttrs(line) {
  const out = [];
  for (const m of line.matchAll(/\[((?:[^\[\]"]|"(?:[^"\\]|\\.)*")*)\]/g)) {
    for (const part of splitTop(m[1])) {
      const mm = part.trim().match(/^(?:\w+\.)*(\w+?)(?:Attribute)?\s*(?:\(([\s\S]*)\))?$/);
      if (!mm) continue;
      const args = mm[2] ? splitTop(mm[2]).map((a) => a.trim()) : [];
      const named = Object.fromEntries(args.map((a) => a.match(/^(\w+)\s*=\s*([\s\S]+)$/)).filter(Boolean).map((x) => [x[1], x[2].replace(/^@?"|"$/g, '')]));
      const positional = args.filter((a) => !/^\w+\s*=/.test(a)).map((a) => a.replace(/^@?"|"$/g, ''));
      out.push({ name: mm[1], positional, named });
    }
  }
  return out;
}

export function parseCSharp(text, rel) {
  if (!/\[\s*(?:\w+\.)*(Test|TestCase|TestCaseSource|Fact|Theory|TestMethod|DataTestMethod)\b/.test(text)) return [];
  const src = stripComments(text);
  const ns = (src.match(/^\s*namespace\s+([\w.]+)\s*[;{]/m) || [])[1] || '';
  const kind = /\b(Fact|Theory)\b/.test(src) && /using\s+Xunit/.test(src) ? 'xunit'
    : /\bTestMethod\b|using\s+Microsoft\.VisualStudio\.TestTools/.test(src) ? 'mstest' : 'nunit';
  const appType = /using\s+(OpenQA\.Selenium|Microsoft\.Playwright|Coypu|Atata)/.test(src) ? 'web'
    : /using\s+(RestSharp|Flurl|Refit|System\.Net\.Http)/.test(src) ? 'api'
      : /(^|\/|\.)(Api|Rest|Contract|Service)s?(\.|\/|Tests)/i.test(rel) ? 'api' : /(^|\/|\.)(Ui|Web|E2e|Pages?)(\.|\/|Tests)/i.test(rel) ? 'web' : null;
  const tests = [];
  const classes = [];                      // { name, depth, attrs }
  let pending = [];
  let depth = 0;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line.startsWith('[') && !/^\[\s*assembly\s*:/.test(line)) {
      pending.push(...parseAttrs(line));
      // attribute may be followed by a declaration on the same line: fall through
    }
    const decl = line.replace(/^(\[[^\]]*\]\s*)+/, '');
    let m;
    if ((m = decl.match(/\b(?:class|record)\s+(\w+)/)) && !/^\s*(\/\/|\*)/.test(decl) && !/\bnew\s+/.test(decl)) {
      classes.push({ name: m[1], depth, attrs: pending });
      pending = [];
    } else if ((m = decl.match(/^(?:(?:public|internal|protected|private|static|async|virtual|override|sealed)\s+)*(?:Task|ValueTask|void)(?:<[^>]*>)?\s+(\w+)\s*\(/))) {
      const name = m[1];
      const testAttr = pending.find((a) => TEST_ATTRS.test(a.name));
      const owner = classes.filter((c) => c.depth < depth);
      if (testAttr && owner.length) {
        const all = [...owner.flatMap((c) => c.attrs), ...pending];
        const cats = uniq([
          ...all.filter((a) => /^(Category|TestCategory)$/.test(a.name)).flatMap((a) => a.positional),
          ...all.filter((a) => a.name === 'Trait').map((a) => (/^category$/i.test(a.positional[0]) ? a.positional[1] : `${a.positional[0]}:${a.positional[1]}`)),
        ]);
        const skip = all.some((a) => /^(Ignore|Explicit)$/.test(a.name)) || Boolean(testAttr.named.Skip);
        const display = testAttr.named.DisplayName || (testAttr.name === 'TestMethod' ? testAttr.positional[0] : undefined)
          || pending.find((a) => a.name === 'Description')?.positional[0];
        const chain = owner.map((c) => c.name).join('+');
        const fqn = `${ns ? ns + '.' : ''}${chain}.${name}`;
        const adoIds = uniq([...all.filter((a) => /^(WorkItem|TestCaseId)$/.test(a.name)).flatMap((a) => a.positional),
          ...all.filter((a) => a.name === 'Property' && /^(TestCaseId|WorkItem|AdoId)$/i.test(a.positional[0])).map((a) => a.positional[1]),
          ...adoIdsIn(name, display)]);
        tests.push({
          id: fqn, kind, file: rel, line: i + 1, class: `${ns ? ns + '.' : ''}${chain}`, method: name,
          title: display || humanize(name), groups: cats,
          ...(skip ? { enabled: false } : {}),
          ...(/^(TestCase|Theory|DataTestMethod|TestCaseSource)$/.test(testAttr.name) || pending.some((a) => /^(TestCase|InlineData|DataRow|MemberData)$/.test(a.name)) ? { parametrized: true } : {}),
          ...(adoIds.length ? { adoIds } : {}),
          appType,
        });
      }
      pending = [];
    } else if (line && !line.startsWith('[')) {
      pending = [];
    }
    // brace depth (strings already safe enough after comment stripping for declaration tracking)
    for (const c of raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)'/g, '')) {
      if (c === '{') depth++;
      else if (c === '}') { depth--; while (classes.length && classes.at(-1).depth >= depth) classes.pop(); }
    }
  }
  return tests;
}

export default {
  id: 'dotnet',
  label: '.NET (NUnit / xUnit / MSTest)',
  markers: [/\.csproj$/, /\.fsproj$/, /\.vbproj$/],
  classify: (rel) => (rel.endsWith('.cs') && !/(^|\/)(obj|bin)\//.test(rel) ? 'maybe' : null),
  parse: parseCSharp,
  junitKeys: (t) => uniq([`${t.class}#${t.method}`, `#${t.id}`, `#${t.title}`, `${t.class.replace(/\+/g, '.')}#${t.method}`]),
  suite({ unit, unitMarkers, tests, outDir, safe, runner }) {
    const proj = unitMarkers.find((m) => /\.(cs|fs|vb)proj$/.test(m));
    const target = proj ? (unit === '.' ? proj : `${unit}/${proj}`) : unit;
    const clauses = tests.map((t) => (t.parametrized ? `FullyQualifiedName~${t.id}` : `FullyQualifiedName=${t.id}`));
    const commands = chunkBy(clauses, 5000).map((c, i) => ({ command:
      (runner.commands?.dotnet || 'dotnet test {project} --filter {filter} --logger {logger}')
        .replace('{project}', () => shq(target)).replace('{filter}', () => shq(c.join('|')))
        .replace('{logger}', () => shq(`trx;LogFileName={reportDir}/dotnet-${safe}-${i + 1}.trx`)) }));
    return { files: [{ path: path.join(outDir, `dotnet-${safe}.txt`), content: tests.map((t) => t.id).join('\n') + '\n' }], commands };
  },
  defaultReports: ['**/TestResults/*.trx', '**/TestResults/**/*.xml'],
};
