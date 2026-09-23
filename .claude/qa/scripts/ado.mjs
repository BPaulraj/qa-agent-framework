#!/usr/bin/env node
// Azure DevOps integration via REST (no az CLI needed). Auth: PAT in env var (default AZURE_DEVOPS_EXT_PAT).
// PAT scopes needed: Work Items (R&W), Test Management (R&W), Code (Read) for PR/commit lookups.
//
// Commands:
//   check                                   verify connection + config
//   get-item <id>                           fetch a work item (story/PBI/bug) as clean JSON, incl. acceptance criteria
//   changed-items --iteration "<path>" [--area "<path>"] | --ids 1,2 | --query <id>
//                                           work items with area path, tags, linked PRs/commits (for regression scoping)
//   pr-files --repo <name> --pr <id>        files changed by an app-repo PR
//   list-plans | list-suites [--plan id]    discover test plan / suite ids for qa.config.json
//   push-cases [files|dirs...] [--suite id] create/update ADO Test Cases from canonical YAML cases (default: all)
//   push-catalog --module <m>[,<m2>] [--suite id] [--limit n]
//                                           create ADO Test Cases for existing automated tests (catalog) with
//                                           associated automation, so runs link to Test Plans
//   find-bugs --text "..."                  search open bugs whose title contains text
//   create-bug <defect.json> [--force]      create an ADO Bug from a defect draft, with evidence attachments
//   publish-run <runId|run.json>            publish a run's results to ADO Test Runs
// Global flags: --dry-run (print what would be written; no writes)
//
// Id mapping is kept in .qa/ado-map.json (commit it): { cases: {caseId: adoId}, catalog: {testId: adoId} }.
// Work items are also tagged "qa:<id>" (YAML cases) so the mapping can be recovered by query.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { repoRoot, loadConfig, loadCases, readData, writeJson, walk, parseArgs, fail, out } from './lib/common.mjs';
import { createAdo } from './lib/ado.mjs';
import { loadCatalog } from './lib/catalog.mjs';
import { automatedTestName, automatedTestType } from './lib/drivers/index.mjs';

// AutomatedTestStorage: the build unit's artifact-ish name (module dir, csproj name, package dir).
const storageOf = (t) => {
  if (t.buildModule === '.' || !t.buildModule) return cfg.project?.name || 'tests';
  return t.buildModule.split('/').pop();
};

const args = parseArgs();
const [cmd, ...rest] = args._;
const DRY = Boolean(args['dry-run']);
const cfg = loadConfig();
const root = repoRoot();
const A = createAdo(cfg);
const { ado, ORG, PROJ, V, PAT, PAT_VAR, api, apiPaged, wiql, wiUrl } = A;
const patch = (path, value) => ({ op: 'add', path, value });
const list = (v) => (v && v !== true ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);

// ---------- helpers ----------
const mapFile = path.join(root, '.qa/ado-map.json');
const loadMap = () => ({ cases: {}, catalog: {}, ...(fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : {}) });
const saveMap = (m) => { if (!DRY) writeJson(mapFile, m); };
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripHtml = (s) => String(s ?? '').replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, '\n').replace(/<li>/gi, '- ').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim();
const prio = (p) => ({ P1: 1, P2: 2, P3: 3, P4: 4 }[p] || 2);


function stepsXml(steps) {
  // Each parameterizedString holds HTML, XML-escaped.
  const cell = (t) => escHtml(t ? `<P>${escHtml(t)}</P>` : '');
  const body = steps.map((s, i) =>
    `<step id="${i + 2}" type="${s.expected ? 'ValidateStep' : 'ActionStep'}">` +
    `<parameterizedString isformatted="true">${cell(s.action)}</parameterizedString>` +
    `<parameterizedString isformatted="true">${cell(s.expected)}</parameterizedString><description/></step>`).join('');
  return `<steps id="0" last="${steps.length + 1}">${body}</steps>`;
}

function caseDescription(c) {
  const parts = [];
  if (c.preconditions?.length) parts.push(`<b>Preconditions</b><ul>${c.preconditions.map((p) => `<li>${escHtml(p)}</li>`).join('')}</ul>`);
  if (c.data && Object.keys(c.data).length) parts.push(`<b>Test data</b><pre>${escHtml(JSON.stringify(c.data, null, 2))}</pre>`);
  if (c.cleanup?.length) parts.push(`<b>Cleanup</b><ul>${c.cleanup.map((p) => `<li>${escHtml(p)}</li>`).join('')}</ul>`);
  parts.push(`<i>Source: ${escHtml(c.id)} · type ${escHtml(c.type)} · ${escHtml(c.appType)} · module ${escHtml(c.module)}${c.journey ? ' · journey ' + escHtml(c.journey) : ''}${c.automation?.script ? ' · script ' + escHtml(c.automation.script) : ''}</i>`);
  return parts.join('');
}

function resolveRun(arg) {
  if (!arg) fail('Pass a runId or path to run.json');
  const candidates = [arg, path.join(arg, 'run.json'), path.join(root, cfg.paths.runs, arg, 'run.json')];
  const f = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!f) fail(`run.json not found for "${arg}"`);
  return path.resolve(f);
}

// ---------- commands ----------
const commands = {
  async check() {
    const p = await api('GET', `${ORG}/_apis/projects/${PROJ}?${V}`);
    const result = { ok: true, organization: ORG, project: p.name, projectId: p.id, patEnvVar: PAT_VAR, areaPath: ado.areaPath || null, iterationPath: ado.iterationPath || null };
    if (ado.testPlanId) {
      const plan = await api('GET', `${ORG}/${PROJ}/_apis/testplan/plans/${ado.testPlanId}?${V}`);
      result.testPlan = { id: plan.id, name: plan.name, rootSuiteId: plan.rootSuite?.id };
    }
    out(result);
  },

  async 'get-item'() {
    const id = rest[0] || fail('usage: get-item <id>');
    const w = await api('GET', `${ORG}/${PROJ}/_apis/wit/workitems/${id}?$expand=relations&${V}`);
    const f = w.fields;
    out({
      id: w.id,
      type: f['System.WorkItemType'],
      title: f['System.Title'],
      state: f['System.State'],
      areaPath: f['System.AreaPath'],
      iterationPath: f['System.IterationPath'],
      tags: f['System.Tags'] || '',
      description: stripHtml(f['System.Description']),
      acceptanceCriteria: stripHtml(f['Microsoft.VSTS.Common.AcceptanceCriteria']),
      reproSteps: f['Microsoft.VSTS.TCM.ReproSteps'] ? stripHtml(f['Microsoft.VSTS.TCM.ReproSteps']) : undefined,
      relations: (w.relations || []).filter((r) => /workItems/i.test(r.url)).map((r) => ({ rel: r.attributes?.name || r.rel, id: Number(r.url.split('/').pop()) })),
      url: w._links?.html?.href,
    });
  },

  async 'changed-items'() {
    const esc = (s) => String(s).replace(/'/g, "''");
    let ids = list(args.ids).map(Number);
    if (args.iteration) {
      ids.push(...await wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.IterationPath] UNDER '${esc(args.iteration)}'` +
        `${args.area ? ` AND [System.AreaPath] UNDER '${esc(args.area)}'` : ''} AND [System.WorkItemType] IN ('User Story','Product Backlog Item','Bug','Feature') AND [System.State] <> 'Removed'`));
    }
    if (args.query) ids.push(...((await api('GET', `${ORG}/${PROJ}/_apis/wit/wiql/${args.query}?${V}`)).workItems || []).map((w) => w.id));
    ids = [...new Set(ids)];
    if (!ids.length) fail('Pass --iteration, --ids or --query (or nothing matched).');
    const items = await A.getWorkItems(ids, { relations: true });
    const rows = items.map((w) => {
      const { prs, commits } = A.gitLinks(w.relations);
      return { id: w.id, type: w.fields['System.WorkItemType'], state: w.fields['System.State'], title: w.fields['System.Title'],
        areaPath: w.fields['System.AreaPath'], tags: w.fields['System.Tags'] || '', prs: prs.length, commits: commits.length };
    });
    const limit = Number(args.limit || 50);
    const byArea = rows.reduce((o, r) => ((o[r.areaPath] = (o[r.areaPath] || 0) + 1), o), {});
    out({ total: rows.length, withCodeLinks: rows.filter((r) => r.prs || r.commits).length,
      byAreaPath: Object.entries(byArea).sort((a, b) => b[1] - a[1]), items: rows.slice(0, limit),
      ...(rows.length > limit ? { note: `Showing ${limit} of ${rows.length}. Use --limit.` } : {}) });
  },

  async 'pr-files'() {
    if (!args.repo || !args.pr) fail('usage: pr-files --repo <name> --pr <id>');
    const files = await A.prFiles(String(args.repo), Number(args.pr));
    const byDir = files.reduce((o, f) => { const d = f.split('/').slice(0, 3).join('/'); o[d] = (o[d] || 0) + 1; return o; }, {});
    out({ repo: args.repo, pr: Number(args.pr), files: files.length, byTopDirs: Object.entries(byDir).sort((a, b) => b[1] - a[1]).slice(0, 30), sample: files.slice(0, 50) });
  },

  async 'push-catalog'() {
    const mods = list(args.module);
    if (!mods.length && !args.all) fail('Pass --module <m>[,<m2>] (or --all, not recommended for large repos).');
    const cat = loadCatalog(cfg);
    const tests = cat.tests.filter((t) => t.enabled !== false && (args.all || mods.includes(t.module)));
    const map = loadMap();
    const pending = tests.filter((t) => !map.catalog[t.id]);
    const batch = pending.slice(0, Number(args.limit || 500));
    const suite = args.suite ? Number(args.suite) : ado.testSuiteId;
    const plan = ado.testPlanId;
    const fieldsFor = (t) => [
      patch('/fields/System.Title', t.title.length > 200 ? t.title.slice(0, 197) + '...' : t.title),
      patch('/fields/System.Description', `<p><b>Automated test</b>: ${escHtml(t.id)}</p><p>File: ${escHtml(t.file)}${t.line ? ':' + t.line : ''}` +
        ` · module: ${escHtml(t.module || 'n/a')} · build module: ${escHtml(t.buildModule)} · groups: ${escHtml(t.groups.join(', '))}</p>`),
      patch('/fields/System.Tags', [...new Set(['qa-automated', `module:${t.module || 'unassigned'}`, ...(t.appType ? [`app:${t.appType}`] : []), ...t.groups.slice(0, 10)])].join('; ')),
      patch('/fields/Microsoft.VSTS.TCM.AutomatedTestName', automatedTestName(t)),
      patch('/fields/Microsoft.VSTS.TCM.AutomatedTestStorage', storageOf(t)),
      patch('/fields/Microsoft.VSTS.TCM.AutomatedTestType', automatedTestType(t)),
      patch('/fields/Microsoft.VSTS.TCM.AutomatedTestId', randomUUID()),
      ...(ado.areaPath ? [patch('/fields/System.AreaPath', ado.areaPath)] : []),
      ...(ado.iterationPath ? [patch('/fields/System.IterationPath', ado.iterationPath)] : []),
    ];
    if (DRY) {
      const sampleTest = batch[0] || tests[0];
      return out({ dryRun: true, modules: mods, tests: tests.length, alreadyLinked: tests.length - pending.length, wouldCreate: batch.length,
        remainingAfterBatch: pending.length - batch.length, suite: suite && plan ? suite : null,
        sample: batch.slice(0, 5).map((t) => ({ id: t.id, title: t.title })), fields: sampleTest ? fieldsFor(sampleTest).map((f) => f.path) : [] });
    }
    const created = [], errors = [], toSuite = [];
    let suiteMembers = new Set();
    if (suite && plan) suiteMembers = new Set((await apiPaged(`${ORG}/${PROJ}/_apis/testplan/Plans/${plan}/Suites/${suite}/TestCase?${V}`)).map((x) => Number(x.workItem.id)));
    for (const [i, t] of batch.entries()) {
      try {
        const w = await api('POST', `${ORG}/${PROJ}/_apis/wit/workitems/$Test%20Case?${V}`, fieldsFor(t), 'application/json-patch+json');
        map.catalog[t.id] = w.id;
        created.push(w.id);
        if (suite && plan && !suiteMembers.has(w.id)) toSuite.push(w.id);
      } catch (e) { errors.push({ id: t.id, error: e.message.slice(0, 200) }); }
      if (i % 25 === 24) { writeJson(mapFile, map); process.stderr.write(`  ${i + 1}/${batch.length}\n`); }
    }
    writeJson(mapFile, map);
    for (let i = 0; i < toSuite.length; i += 100) {
      await api('POST', `${ORG}/${PROJ}/_apis/testplan/Plans/${plan}/Suites/${suite}/TestCase?${V}`, toSuite.slice(i, i + 100).map((id) => ({ workItem: { id } })));
    }
    out({ created: created.length, addedToSuite: toSuite.length, errors: errors.slice(0, 20), errorCount: errors.length,
      remaining: pending.length - batch.length, next: pending.length > batch.length ? 'Re-run to continue with the next batch.' : 'Module(s) fully linked.' });
    if (errors.length) process.exit(1);
  },

  async 'list-plans'() {
    const r = await api('GET', `${ORG}/${PROJ}/_apis/testplan/plans?filterActivePlans=true&${V}`);
    out((r.value || []).map((p) => ({ id: p.id, name: p.name, rootSuiteId: p.rootSuite?.id, iteration: p.iteration })));
  },

  async 'list-suites'() {
    const plan = args.plan || ado.testPlanId || fail('Pass --plan <id> or set ado.testPlanId');
    const r = await api('GET', `${ORG}/${PROJ}/_apis/testplan/Plans/${plan}/suites?${V}`);
    out((r.value || []).map((s) => ({ id: s.id, name: s.name, type: s.suiteType, parent: s.parentSuite?.id })));
  },

  async 'push-cases'() {
    const suite = args.suite ? Number(args.suite) : ado.testSuiteId;
    const plan = ado.testPlanId;
    let entries = loadCases(cfg);
    if (rest.length) {
      const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
      const wanted = new Set(rest.flatMap((p) => {
        const abs = real(p);
        return fs.existsSync(abs) && fs.statSync(abs).isDirectory()
          ? walk(abs, { filter: (f) => /\.(ya?ml|json)$/i.test(f) }).map((f) => path.join(abs, f)) : [abs];
      }));
      entries = entries.filter((e) => wanted.has(real(e.file)));
      if (!entries.length) fail(`No cases matched ${rest.join(', ')}`);
    }
    const bad = entries.filter((e) => e.error || !e.case?.id);
    if (bad.length) fail(`Fix unparsable cases first:\n${bad.map((b) => ` - ${b.file}: ${b.error || 'missing id'}`).join('\n')}`);

    const map = loadMap();
    const summary = { dryRun: DRY, created: [], updated: [], addedToSuite: [], errors: [] };
    let suiteMembers = null;
    if (suite && plan && PAT) {
      suiteMembers = new Set((await apiPaged(`${ORG}/${PROJ}/_apis/testplan/Plans/${plan}/Suites/${suite}/TestCase?${V}`)).map((x) => Number(x.workItem.id)));
    }

    for (const { file, case: c } of entries) {
      try {
        let adoId = map.cases[c.id];
        if (!adoId && PAT) {
          const found = await wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Test Case' AND [System.Tags] CONTAINS 'qa:${c.id}'`);
          if (found.length) adoId = found[0];
        }
        const tags = [...new Set([`qa:${c.id}`, `qa-${c.type}`, `module:${c.module}`, ...(c.journey ? [`journey:${c.journey}`] : []),
          ...(c.automation?.status === 'automated' ? ['automated'] : []), ...(c.tags || [])])].join('; ');
        const doc = [
          patch('/fields/System.Title', `${c.id} ${c.title}`),
          patch('/fields/Microsoft.VSTS.TCM.Steps', stepsXml(c.steps)),
          patch('/fields/System.Description', caseDescription(c)),
          patch('/fields/Microsoft.VSTS.Common.Priority', prio(c.priority)),
          patch('/fields/System.Tags', tags),
          ...(ado.areaPath ? [patch('/fields/System.AreaPath', ado.areaPath)] : []),
          ...(ado.iterationPath ? [patch('/fields/System.IterationPath', ado.iterationPath)] : []),
        ];
        const reqId = c.requirement?.adoId;
        let existingRels = [];
        if (adoId && reqId && PAT) {
          const w = await api('GET', `${ORG}/${PROJ}/_apis/wit/workitems/${adoId}?$expand=relations&${V}`);
          existingRels = (w.relations || []).map((r) => r.url.toLowerCase());
        }
        if (reqId && !existingRels.includes(wiUrl(reqId).toLowerCase())) {
          doc.push(patch('/relations/-', { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: wiUrl(reqId), attributes: { comment: 'Linked by QA framework' } }));
        }
        const relFile = path.relative(root, file).split(path.sep).join('/');
        if (DRY) {
          (adoId ? summary.updated : summary.created).push({ caseId: c.id, adoId: adoId || null, file: relFile, fields: doc.map((d) => d.path) });
        } else if (adoId) {
          await api('PATCH', `${ORG}/${PROJ}/_apis/wit/workitems/${adoId}?${V}`, doc, 'application/json-patch+json');
          summary.updated.push({ caseId: c.id, adoId });
        } else {
          const w = await api('POST', `${ORG}/${PROJ}/_apis/wit/workitems/$Test%20Case?${V}`, doc, 'application/json-patch+json');
          adoId = w.id;
          summary.created.push({ caseId: c.id, adoId, url: w._links?.html?.href });
        }
        if (adoId) map.cases[c.id] = adoId;
        if (suite && plan && adoId && !(suiteMembers?.has(Number(adoId)))) {
          if (!DRY) await api('POST', `${ORG}/${PROJ}/_apis/testplan/Plans/${plan}/Suites/${suite}/TestCase?${V}`, [{ workItem: { id: adoId } }]);
          summary.addedToSuite.push({ caseId: c.id, adoId, suite });
        } else if (suite && plan && DRY && !adoId) {
          summary.addedToSuite.push({ caseId: c.id, adoId: '(new)', suite });
        }
      } catch (e) {
        summary.errors.push({ caseId: c.id, error: e.message });
      }
    }
    saveMap(map);
    out(summary);
    if (summary.errors.length) process.exit(1);
  },

  async 'find-bugs'() {
    const text = args.text || fail('usage: find-bugs --text "..."');
    const ids = await wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Bug' AND [System.State] NOT IN ('Closed','Done','Removed','Resolved') AND [System.Title] CONTAINS '${String(text).replace(/'/g, "''")}' ORDER BY [System.ChangedDate] DESC`);
    if (!ids.length) return out([]);
    const r = await api('GET', `${ORG}/${PROJ}/_apis/wit/workitems?ids=${ids.slice(0, 50).join(',')}&fields=System.Id,System.Title,System.State,Microsoft.VSTS.Common.Severity,System.AssignedTo&${V}`);
    out((r.value || []).map((w) => ({ id: w.id, title: w.fields['System.Title'], state: w.fields['System.State'], severity: w.fields['Microsoft.VSTS.Common.Severity'], assignedTo: w.fields['System.AssignedTo']?.displayName })));
  },

  async 'create-bug'() {
    const file = rest[0] || fail('usage: create-bug <defect.json>');
    const d = readData(file);
    for (const k of ['title', 'severity', 'priority', 'steps', 'expected', 'actual']) if (!d[k]) fail(`defect missing "${k}"`);
    if (d.adoBugId && !args.force) fail(`Defect already filed as ADO bug ${d.adoBugId}. Use --force to file again.`);

    if (PAT && !args.force) {
      const safe = d.title.replace(/'/g, "''");
      const dup = await wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Bug' AND [System.State] NOT IN ('Closed','Done','Removed') AND [System.Title] = '${safe}'`);
      if (dup.length) fail(`An open bug with the same title exists: ${dup.join(', ')}. Review it; use --force to create anyway.`);
    }

    const map = loadMap();
    const tcId = d.adoTestCaseId || (d.caseId && map.cases[d.caseId]);
    const li = (a) => `<ol>${a.map((s) => `<li>${escHtml(s)}</li>`).join('')}</ol>`;
    const repro = [
      d.preconditions?.length ? `<b>Preconditions</b><ul>${d.preconditions.map((p) => `<li>${escHtml(p)}</li>`).join('')}</ul>` : '',
      `<b>Steps to reproduce</b>${li(d.steps)}`,
      `<b>Expected</b><p>${escHtml(d.expected)}</p>`,
      `<b>Actual</b><p>${escHtml(d.actual)}</p>`,
      d.frequency ? `<p><b>Frequency:</b> ${escHtml(d.frequency)}</p>` : '',
      d.notes ? `<b>Notes</b><p>${escHtml(d.notes)}</p>` : '',
      `<p><i>Filed by QA framework${d.caseId ? ` · case ${escHtml(d.caseId)}` : ''}${d.runId ? ` · run ${escHtml(d.runId)}` : ''}</i></p>`,
    ].join('');
    const sysInfo = [d.environment && `Environment: ${d.environment}`, d.build && `Build: ${d.build}`, d.browser && `Browser: ${d.browser}`].filter(Boolean).map(escHtml).join('<br>');
    const tags = [...new Set(['qa-framework', ...(d.module ? [`module:${d.module}`] : []), ...(ado.bugDefaults?.tags || []), ...(d.tags || [])])].join('; ');
    const doc = [
      patch('/fields/System.Title', d.title),
      patch('/fields/Microsoft.VSTS.TCM.ReproSteps', repro),
      patch('/fields/Microsoft.VSTS.TCM.SystemInfo', sysInfo),
      patch('/fields/Microsoft.VSTS.Common.Severity', d.severity),
      patch('/fields/Microsoft.VSTS.Common.Priority', d.priority),
      patch('/fields/System.Tags', tags),
      ...(ado.areaPath ? [patch('/fields/System.AreaPath', ado.areaPath)] : []),
      ...(ado.iterationPath ? [patch('/fields/System.IterationPath', ado.iterationPath)] : []),
      ...(ado.bugDefaults?.assignedTo ? [patch('/fields/System.AssignedTo', ado.bugDefaults.assignedTo)] : []),
      ...(tcId ? [patch('/relations/-', { rel: 'System.LinkTypes.Related', url: wiUrl(tcId), attributes: { comment: 'Failing test case' } })] : []),
      ...(d.requirementAdoId ? [patch('/relations/-', { rel: 'System.LinkTypes.Related', url: wiUrl(d.requirementAdoId), attributes: { comment: 'Requirement' } })] : []),
    ];

    const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
    const evidence = (d.evidence || []).map((e) => (path.isAbsolute(e) ? e : path.resolve(path.dirname(file), '..', e)))
      .map((e, i) => real(fs.existsSync(e) ? e : path.resolve(root, d.evidence[i])));
    const missing = evidence.filter((e) => !fs.existsSync(e));
    if (DRY) return out({ dryRun: true, fields: doc.map((x) => x.path), title: d.title, linkedTestCase: tcId || null, attachments: evidence.filter((e) => fs.existsSync(e)).map((e) => path.relative(root, e).split(path.sep).join('/')), missingEvidence: missing });

    for (const e of evidence.filter((x) => fs.existsSync(x))) {
      const a = await api('POST', `${ORG}/${PROJ}/_apis/wit/attachments?fileName=${encodeURIComponent(path.basename(e))}&${V}`, fs.readFileSync(e), 'application/octet-stream');
      doc.push(patch('/relations/-', { rel: 'AttachedFile', url: a.url, attributes: { comment: 'Evidence' } }));
    }
    const w = await api('POST', `${ORG}/${PROJ}/_apis/wit/workitems/$Bug?${V}`, doc, 'application/json-patch+json');
    d.adoBugId = w.id;
    writeJson(file, d);
    out({ created: w.id, url: w._links?.html?.href, attachments: evidence.length - missing.length, missingEvidence: missing });
  },

  async 'publish-run'() {
    const file = resolveRun(rest[0]);
    const runDir = path.dirname(file);
    const run = readData(file);
    if (run.ado?.runId && !args.force) fail(`Run already published as ADO run ${run.ado.runId}. Use --force to publish again.`);
    const map = loadMap();
    const cat = loadCatalog(cfg, { rebuild: false }) || { tests: [] };
    const byId = new Map(cat.tests.map((t) => [t.id, t]));
    const outcome = { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', skipped: 'NotExecuted' };
    const plan = ado.testPlanId;
    const suite = args.suite ? Number(args.suite) : ado.testSuiteId;
    const results = run.results.map((r) => ({ ...r, adoTestCaseId: map.cases[r.caseId] || map.catalog[r.caseId] || null }));
    const unmapped = results.filter((r) => !r.adoTestCaseId).map((r) => r.caseId);
    const cap = (a, n = 20) => (a.length > n ? [...a.slice(0, n), `… +${a.length - n} more`] : a);
    const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

    const comment = (r) => [r.notes, r.failure?.cluster && `Failure cluster #${r.failure.cluster}`,
      r.failure?.classification && `Classification: ${r.failure.classification} (${r.failure.confidence || 'n/a'})`,
      r.failure?.reasoning, r.defect && `Defect: ${r.defect}`].filter(Boolean).join('\n').slice(0, 1000);
    const errorMessage = (r) => (r.failure
      ? `${r.failure.step ? `Step ${r.failure.step}: ` : ''}${r.failure.expected ? `expected ${r.failure.expected}; actual ` : ''}${r.failure.actual || '?'}`.slice(0, 1000)
      : undefined);
    const autoName = (id) => { const t = byId.get(id); return t ? automatedTestName(t) : id; };
    const storage = (id) => { const t = byId.get(id); return t ? storageOf(t) : cfg.project?.name || 'qa'; };

    const planMode = Boolean(plan && suite);
    let points = null;
    if (planMode && PAT) {
      points = new Map((await apiPaged(`${ORG}/${PROJ}/_apis/testplan/Plans/${plan}/Suites/${suite}/TestPoint?${V}`)).map((p) => [Number(p.testCaseReference?.id), p.id]));
    }
    const noPoint = planMode && points ? results.filter((r) => r.adoTestCaseId && !points.has(Number(r.adoTestCaseId))).map((r) => r.caseId) : [];

    if (DRY) {
      return out({ dryRun: true, mode: planMode ? `plan ${plan} / suite ${suite}` : 'standalone run', name: run.name, total: results.length,
        publishable: planMode ? results.length - unmapped.length - noPoint.length : results.length,
        notInAdo: unmapped.length, notInAdoSample: cap(unmapped, 10), notInSuite: noPoint.length,
        hint: unmapped.length ? (planMode ? 'Unmapped results are skipped in a planned run. Run push-cases / push-catalog --suite first.'
          : 'Unmapped results are published by automated test name without a Test Case link. Run push-catalog for traceability.') : undefined });
    }

    let adoRun;
    const published = [];
    if (planMode) {
      const eligible = results.filter((r) => r.adoTestCaseId && points.has(Number(r.adoTestCaseId)));
      if (!eligible.length) fail('No results map to test points in the configured suite. Run push-cases / push-catalog with --suite first.');
      adoRun = await api('POST', `${ORG}/${PROJ}/_apis/test/runs?${V}`, {
        name: run.name, plan: { id: String(plan) }, pointIds: eligible.map((r) => points.get(Number(r.adoTestCaseId))),
        automated: eligible.some((r) => r.mode === 'scripted'), state: 'InProgress',
        comment: `QA framework run ${run.runId} on ${run.environment}${run.build ? ' · build ' + run.build : ''}`,
      });
      const byTc = new Map();
      for (let skip = 0; ; skip += 1000) {
        const page = await api('GET', `${ORG}/${PROJ}/_apis/test/Runs/${adoRun.id}/results?$top=1000&$skip=${skip}&${V}`);
        (page.value || []).forEach((x) => byTc.set(Number(x.testCase?.id), x.id));
        if ((page.value || []).length < 1000) break;
      }
      const updates = eligible.map((r) => ({ id: byTc.get(Number(r.adoTestCaseId)), outcome: outcome[r.status], state: 'Completed',
        comment: comment(r), errorMessage: errorMessage(r), durationInMs: r.durationMs })).filter((u) => u.id);
      for (const c of chunks(updates, 200)) await api('PATCH', `${ORG}/${PROJ}/_apis/test/Runs/${adoRun.id}/results?${V}`, c);
      eligible.forEach((r) => published.push({ r, resultId: byTc.get(Number(r.adoTestCaseId)) }));
    } else {
      adoRun = await api('POST', `${ORG}/${PROJ}/_apis/test/runs?${V}`, { name: run.name, automated: true, state: 'InProgress',
        comment: `QA framework run ${run.runId} on ${run.environment}` });
      for (const c of chunks(results, 200)) {
        const body = c.map((r) => ({ testCaseTitle: byId.get(r.caseId)?.title || r.caseId, automatedTestName: autoName(r.caseId), automatedTestStorage: storage(r.caseId),
          outcome: outcome[r.status], state: 'Completed', comment: comment(r), errorMessage: errorMessage(r), durationInMs: r.durationMs,
          ...(r.adoTestCaseId ? { testCase: { id: String(r.adoTestCaseId) } } : {}) }));
        const created = await api('POST', `${ORG}/${PROJ}/_apis/test/Runs/${adoRun.id}/results?${V}`, body);
        (created.value || []).forEach((x, i) => published.push({ r: c[i], resultId: x.id }));
      }
    }

    // Evidence attachments for non-passing results only (≤ 10 MB each)
    const skipped = [];
    let attached = 0;
    for (const { r, resultId } of published.filter((p) => p.r.status !== 'passed')) {
      for (const e of r.evidence || []) {
        const f = path.resolve(runDir, e);
        if (!fs.existsSync(f)) { skipped.push(`${e} (missing)`); continue; }
        if (fs.statSync(f).size > 10 * 1024 * 1024) { skipped.push(`${e} (>10MB)`); continue; }
        await api('POST', `${ORG}/${PROJ}/_apis/test/Runs/${adoRun.id}/Results/${resultId}/attachments?api-version=7.1-preview.1`,
          { stream: fs.readFileSync(f).toString('base64'), fileName: path.basename(f), attachmentType: 'GeneralAttachment', comment: r.caseId });
        attached++;
      }
    }
    await api('PATCH', `${ORG}/${PROJ}/_apis/test/runs/${adoRun.id}?${V}`, { state: 'Completed' });
    run.ado = { runId: adoRun.id, url: adoRun.webAccessUrl };
    writeJson(file, run);
    out({ adoRunId: adoRun.id, url: adoRun.webAccessUrl, published: published.length, attachments: attached,
      notInAdo: unmapped.length, notInSuite: noPoint.length, skippedEvidence: cap(skipped, 10) });
  },
};

if (!cmd || !commands[cmd]) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().catch((e) => fail(e.message));
