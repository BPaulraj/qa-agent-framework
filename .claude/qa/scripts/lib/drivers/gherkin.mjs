// Gherkin driver: .feature files for Cucumber (JVM / JS), SpecFlow / Reqnroll (.NET), behave (Python).
// The runner is chosen from the build unit the feature lives in (pom/gradle, package.json, csproj, python project).
import path from 'node:path';
import { uniq, shq } from '../scan.mjs';

export function parseFeature(text, rel) {
  const tests = [];
  let featureTags = [], pendingTags = [], featureName = '';
  const seen = new Map();
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('#')) return;
    if (t.startsWith('@')) { pendingTags.push(...t.split(/\s+/).filter((x) => x.startsWith('@')).map((x) => x.slice(1))); return; }
    let mm;
    if ((mm = t.match(/^(?:Feature|Business Need|Ability):\s*(.*)$/))) { featureName = mm[1]; featureTags = pendingTags; pendingTags = []; return; }
    if ((mm = t.match(/^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/))) {
      const name = mm[2] || `line ${i + 1}`;
      const n = (seen.get(name) || 0) + 1;
      seen.set(name, n);
      const groups = uniq([...featureTags, ...pendingTags]);
      const adoIds = uniq(groups.flatMap((g) => (g.match(/^(?:TC|ADO|TestCase)[-_:]?(\d{3,})$/i) || []).slice(1)));
      tests.push({ id: `${rel}#${name}${n > 1 ? `#${n}` : ''}`, kind: 'cucumber', file: rel, line: i + 1, feature: featureName,
        title: name, groups, ...(groups.some((g) => /^(ignore|wip|skip|manual)$/i.test(g)) ? { enabled: false } : {}),
        ...(adoIds.length ? { adoIds } : {}),
        appType: groups.some((g) => /^(api|rest)$/i.test(g)) ? 'api' : groups.some((g) => /^(ui|web|e2e)$/i.test(g)) ? 'web' : null });
      pendingTags = [];
      return;
    }
    if (/^(Background|Rule|Examples|Scenarios):/.test(t)) pendingTags = [];
  });
  return tests;
}

export default {
  id: 'gherkin',
  label: 'Gherkin (Cucumber / SpecFlow / Reqnroll / behave)',
  markers: [],
  classify: (rel) => (rel.endsWith('.feature') ? 'test' : null),
  parse: parseFeature,
  junitKeys: (t) => [`${t.feature}#${t.title}`, `#${t.title}`],
  suite({ unit, unitMarkers, tests, outDir, safe, runner }) {
    const rel = (f) => (unit === '.' ? f : path.posix.relative(unit, f));
    const locs = tests.map((t) => `${rel(t.file)}:${t.line}`);
    const has = (re) => unitMarkers.some((m) => re.test(m));
    const cd = unit === '.' ? '' : `cd ${shq(unit)} && `;
    let command, note;
    if (has(/^pom\.xml$/)) {
      command = (runner.cucumberCommand || runner.commands?.cucumber || 'mvn -q {pl} test -Dcucumber.features={features}')
        .replace('{pl}', () => unit === '.' ? '' : `-pl ${unit}`).replace('{module}', () => unit).replace('{features}', () => shq(locs.join(',')));
      note = 'Requires the Cucumber runner to honour -Dcucumber.features (Cucumber-JVM ≥ 5).';
    } else if (has(/^build\.gradle/)) {
      command = `${cd}gradle test -Dcucumber.features=${shq(locs.join(','))}`;
      note = 'Gradle must forward system properties to the test JVM (systemProperty "cucumber.features", ...). (verify)';
    } else if (has(/^package\.json$/)) {
      command = (runner.commands?.['cucumber-js'] || '{cd}npx cucumber-js {features} --format junit:{report}')
        .replace('{cd}', () => cd).replace('{features}', () => locs.map(shq).join(' ')).replace('{report}', () => '{reportDir}/cucumber-' + safe + '.xml');
    } else if (has(/\.csproj$/)) {
      const filter = tests.map((t) => `DisplayName~${t.title.replace(/[|&()!=~"]/g, ' ').trim()}`).join('|');
      command = `${cd}dotnet test --filter ${shq(filter)} --logger ${shq('trx;LogFileName={reportDir}/specflow-' + safe + '.trx')}`;
      note = 'SpecFlow/Reqnroll map scenarios to test methods; DisplayName matching may need adjusting. (verify)';
    } else {
      command = (runner.commands?.behave || '{cd}behave {features} --junit --junit-directory {reportDir}/behave-' + safe)
        .replace('{cd}', () => cd).replace('{features}', () => locs.map(shq).join(' '));
    }
    return { files: [{ path: path.join(outDir, `features-${safe}.txt`), content: locs.join('\n') + '\n' }], commands: [{ command, ...(note ? { note } : {}) }] };
  },
  defaultReports: ['**/target/cucumber*/*.xml', '**/reports/**/*.xml'],
};
