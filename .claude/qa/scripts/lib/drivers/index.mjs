// Stack driver registry. A driver teaches the framework one test stack:
//
//   id, label
//   markers        build-unit marker files (strings or RegExps), e.g. 'pom.xml', /\.csproj$/
//   classify(rel)  'test' (parse) | 'maybe' (read + parse; non-test => shared source) | 'source' | null
//   parse(text, rel) -> catalog entries: { id, kind, file, line, title, groups, appType, enabled?, class?, method?, ... }
//   junitKeys(entry, { unit }) -> keys "<classname>#<name>" / "#<name>" as they appear in JUnit/TRX reports
//   suite({ unit, unitMarkers, tests, outDir, safe, runner, root }) -> { files: [{path, content}], commands: [{command, note?}] }
//                  commands may use {reportDir}; make-suite substitutes the run's report folder
//   defaultReports report globs the stack's runners write by default
//
// Add a stack: create drivers/<name>.mjs with this shape and register it below.
import java from './java.mjs';
import gherkin from './gherkin.mjs';
import js from './js.mjs';
import python from './python.mjs';
import dotnet from './dotnet.mjs';

export const drivers = [java, gherkin, js, python, dotnet];
export const driverById = Object.fromEntries(drivers.map((d) => [d.id, d]));
export const allMarkers = drivers.flatMap((d) => d.markers);

/** First driver that claims the file, with its classification. */
export function classify(rel) {
  for (const d of drivers) {
    const c = d.classify(rel);
    if (c) return { driver: d, cls: c };
  }
  return null;
}

/** Name used for ADO "associated automation" (AutomatedTestName). */
export function automatedTestName(t) {
  if (t.driver === 'java' || (!t.driver && t.class && t.method && t.kind !== 'cucumber')) return `${t.class}.${t.method}`;
  if (t.kind === 'cucumber') return `${t.file}:${t.line}`;
  return t.id;   // dotnet FQN, pytest node id, js file#title path
}

export const automatedTestType = (t) => ({ testng: 'TestNG', junit4: 'JUnit', junit5: 'JUnit', cucumber: 'Cucumber', playwright: 'Playwright',
  jest: 'Jest', vitest: 'Vitest', cypress: 'Cypress', mocha: 'Mocha', js: 'JavaScript', pytest: 'pytest', unittest: 'unittest',
  nunit: 'NUnit', xunit: 'xUnit', mstest: 'MSTest' }[t.kind] || t.kind);
