#!/usr/bin/env node
// Scans the repo for stack and test-tooling markers. Used by /qa-init.
// Usage: node .claude/qa/scripts/detect-stack.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { repoRoot, walk, out } from './lib/common.mjs';

const root = repoRoot();
const files = walk(root, { maxDepth: 20 });
const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };
const has = (re) => files.filter((f) => re.test(f));

const found = { languages: new Set(), web: new Set(), api: new Set(), unit: new Set(), bdd: new Set(), appFrameworks: new Set() };
const evidenceMap = new Map(); // bounded: count + up to 3 example files per finding
const note = (bucket, name, where) => {
  found[bucket].add(name);
  const k = `${bucket}:${name}`;
  const e = evidenceMap.get(k) || { finding: k, files: 0, examples: [] };
  e.files++; if (e.examples.length < 3) e.examples.push(where);
  evidenceMap.set(k, e);
};
const evidence = [];

// --- JavaScript / TypeScript
for (const pkg of has(/(^|\/)package\.json$/)) {
  let json; try { json = JSON.parse(read(pkg)); } catch { continue; }
  const deps = { ...json.dependencies, ...json.devDependencies };
  found.languages.add(deps.typescript || has(/tsconfig\.json$/).length ? 'typescript' : 'javascript');
  const map = {
    web: { '@playwright/test': 'playwright', cypress: 'cypress', 'selenium-webdriver': 'selenium', webdriverio: 'webdriverio', '@wdio/cli': 'webdriverio', testcafe: 'testcafe', puppeteer: 'puppeteer' },
    api: { supertest: 'supertest', axios: 'axios', pactum: 'pactum', '@pact-foundation/pact': 'pact', newman: 'postman-newman', 'frisby': 'frisby' },
    unit: { jest: 'jest', vitest: 'vitest', mocha: 'mocha', jasmine: 'jasmine' },
    bdd: { '@cucumber/cucumber': 'cucumber-js', 'playwright-bdd': 'playwright-bdd' },
    appFrameworks: { react: 'react', '@angular/core': 'angular', vue: 'vue', next: 'nextjs', express: 'express', '@nestjs/core': 'nestjs', svelte: 'svelte' },
  };
  for (const [bucket, m] of Object.entries(map)) for (const [dep, name] of Object.entries(m)) if (deps[dep]) note(bucket, name, pkg);
  if (json.scripts) evidence.push({ npmScripts: Object.keys(json.scripts).filter((s) => /test|e2e|api|smoke|regress/i.test(s)), where: pkg });
}
has(/playwright\.config\.(ts|js|mjs|cjs)$/).forEach((f) => note('web', 'playwright', f));
has(/cypress\.config\.(ts|js|mjs|cjs)$/).forEach((f) => note('web', 'cypress', f));
has(/wdio\.conf\.(ts|js)$/).forEach((f) => note('web', 'webdriverio', f));

// --- Java
for (const f of has(/(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/)) {
  found.languages.add('java');
  const t = read(f);
  const m = { 'selenium-java': ['web', 'selenium'], 'com.microsoft.playwright': ['web', 'playwright'], selenide: ['web', 'selenide'],
    'rest-assured': ['api', 'restassured'], karate: ['api', 'karate'], testng: ['unit', 'testng'], junit: ['unit', 'junit'],
    'cucumber-java': ['bdd', 'cucumber-jvm'], 'spring-boot': ['appFrameworks', 'spring-boot'] };
  for (const [k, [b, n]] of Object.entries(m)) if (t.includes(k)) note(b, n, f);
}

// --- Java monorepo specifics: build modules, surefire/TestNG suite wiring, test-only hint
const poms = has(/(^|\/)pom\.xml$/);
const gradles = has(/(^|\/)build\.gradle(\.kts)?$/);
const javaFiles = has(/\.java$/);
const javaInfo = javaFiles.length ? (() => {
  const mainJava = javaFiles.filter((f) => /\/src\/main\/java\//.test(f)).length;
  const testJava = javaFiles.filter((f) => /\/src\/test\/java\//.test(f) || /(^|\/)src\/test\//.test(f)).length;
  const suiteProps = new Set();
  let hardcodedSuites = false;
  for (const p of poms) {
    const t = read(p);
    for (const m of t.matchAll(/<suiteXmlFile>\s*\$\{([\w.-]+)\}\s*<\/suiteXmlFile>/g)) suiteProps.add(m[1]);
    if (/<suiteXmlFile>\s*[^$<\s][^<]*<\/suiteXmlFile>/.test(t)) hardcodedSuites = true;
  }
  const sample = javaFiles.slice(0, 400).map(read).join('\n');
  return {
    buildTool: poms.length ? 'maven' : gradles.length ? 'gradle' : 'unknown',
    buildModules: poms.length ? poms.length - (poms.includes('pom.xml') ? 1 : 0) : gradles.length,
    javaFiles: javaFiles.length,
    srcMainJava: mainJava,
    srcTestJava: testJava,
    repoTypeHint: mainJava > testJava * 2 ? 'app-and-tests' : 'tests-only',
    testngSuiteFiles: has(/(^|\/)testng[^/]*\.xml$/i).slice(0, 15),
    surefire: { suiteXmlProperties: [...suiteProps], hardcodedSuiteXml: hardcodedSuites },
    reporting: [/io\.qameta\.allure/.test(sample) && 'allure', /extentreports/i.test(sample) && 'extent', /reportportal/i.test(sample) && 'reportportal'].filter(Boolean),
    cucumberRunners: /AbstractTestNGCucumberTests|@CucumberOptions/.test(sample),
  };
})() : null;

// --- Python
for (const f of has(/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.cfg)$/)) {
  found.languages.add('python');
  const t = read(f).toLowerCase();
  const m = { 'pytest-playwright': ['web', 'playwright'], playwright: ['web', 'playwright'], selenium: ['web', 'selenium'],
    'robotframework': ['web', 'robotframework'], requests: ['api', 'requests'], httpx: ['api', 'httpx'], pytest: ['unit', 'pytest'],
    behave: ['bdd', 'behave'], 'pytest-bdd': ['bdd', 'pytest-bdd'], django: ['appFrameworks', 'django'], fastapi: ['appFrameworks', 'fastapi'], flask: ['appFrameworks', 'flask'] };
  for (const [k, [b, n]] of Object.entries(m)) if (t.includes(k)) note(b, n, f);
}

// --- .NET
for (const f of has(/\.csproj$/)) {
  found.languages.add('csharp');
  const t = read(f);
  const m = { 'Selenium.WebDriver': ['web', 'selenium'], 'Microsoft.Playwright': ['web', 'playwright'], RestSharp: ['api', 'restsharp'],
    'Microsoft.AspNetCore.Mvc.Testing': ['api', 'aspnetcore-testhost'], NUnit: ['unit', 'nunit'], xunit: ['unit', 'xunit'], MSTest: ['unit', 'mstest'],
    SpecFlow: ['bdd', 'specflow'], Reqnroll: ['bdd', 'reqnroll'] };
  for (const [k, [b, n]] of Object.entries(m)) if (t.includes(k)) note(b, n, f);
}

// --- Test assets
const apiSpecs = files.filter((f) => /(openapi|swagger)[^/]*\.(ya?ml|json)$/i.test(f) || /\.graphql$|schema\.gql$/i.test(f));
const postman = has(/\.postman_collection\.json$/);
const features = has(/\.feature$/);
const testDirs = [...new Set(files.map((f) => f.split('/').slice(0, -1).join('/'))
  .filter((d) => /(^|\/)(e2e|tests?|specs?|cypress|playwright|api-?tests?|integration|regression|automation)(\/|$)/i.test(d))
  .map((d) => d.split('/').slice(0, 3).join('/')))].slice(0, 20);
const envFiles = has(/(^|\/)\.env(\.[\w-]+)?$/).map((f) => ({ file: f, keys: read(f).split(/\r?\n/).map((l) => l.split('=')[0].trim()).filter((k) => k && !k.startsWith('#')) }));
const ci = has(/(^|\/)(azure-pipelines[^/]*\.ya?ml|\.github\/workflows\/[^/]+\.ya?ml|Jenkinsfile|\.gitlab-ci\.yml)$/);

// --- Git / Azure DevOps
let git = null;
try {
  const remote = execSync('git remote get-url origin', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const branch = (() => { try { return execSync('git symbolic-ref --short refs/remotes/origin/HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().replace('origin/', ''); } catch { return null; } })();
  git = { remote, defaultBranch: branch };
  const m = remote.match(/dev\.azure\.com[/:](?:v3\/)?([^/]+)\/([^/]+)\/(?:_git\/)?([^/]+)/) || remote.match(/([^/.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)/);
  if (m) git.ado = { organization: `https://dev.azure.com/${decodeURIComponent(m[1])}`, project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };
} catch { /* not a git repo or no origin */ }

const toArr = (s) => [...s];
out({
  root,
  languages: toArr(found.languages),
  appFrameworks: toArr(found.appFrameworks),
  suggestedAppTypes: [
    ...(found.web.size || found.appFrameworks.size ? ['web'] : []),
    ...(found.api.size || apiSpecs.length || postman.length ? ['api'] : []),
  ],
  java: javaInfo,
  webAutomation: toArr(found.web),
  apiAutomation: toArr(found.api),
  unitFrameworks: toArr(found.unit),
  bdd: toArr(found.bdd),
  testDirs,
  apiSpecs,
  postmanCollections: postman,
  featureFiles: features.length,
  envFiles,
  ci,
  git,
  existingQaConfig: fs.existsSync(path.join(root, 'qa.config.json')),
  existingPacks: fs.existsSync(path.join(root, '.claude/skills'))
    ? fs.readdirSync(path.join(root, '.claude/skills')).filter((d) => d.startsWith('pack-')) : [],
  evidence: [...evidenceMap.values(), ...evidence.slice(0, 10)],
});
