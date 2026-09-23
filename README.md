# QA Agent Framework for Claude Code

A portable, drop-in `.claude/` folder that turns Claude Code into a QA engineer for **any repo**. It
covers functional, integration, and regression testing of **web** and **API** applications, with
**Azure DevOps** integration. Every team plugs in its own product knowledge without forking the core.

## Why it's layered

Teams differ in process, tech stack, domain, and app type. The framework treats these as independent,
pluggable layers:

```
L3  Repo config      qa.config.json                 environments, stack, packs, ADO   (per repo)
L2  Product packs    .claude/skills/pack-*/         journeys, rules, data, module map (per team)
L1  Adapters         .claude/skills/qa-adapter-*/   how to drive web / api            (per app type)
L0  Core             .claude/skills/qa-*/           how to test: design, functional,  (org-wide)
                                                    integration, regression, defects
Precedence: L3 > L2 > L1 > L0
```

Shared **schemas** (test case, run, defect, config) are the contracts between layers. As long as
a pack or adapter speaks them, everything else keeps working.

## Install into a repo

Requires Node ≥ 18 (for the helper scripts) and Claude Code.

```bash
node install.mjs /path/to/target-repo            # add --dry-run to preview
```

Or copy these into the target repo's `.claude/` folder by hand: `qa/`, `skills/qa-*`, `agents/qa-*`,
`commands/qa-*`, and merge `settings.json`. The installer does this safely. It merges
`settings.json`, never touches your packs, config, or `.qa/` data, and is re-runnable for upgrades.

Then, in the target repo:

```
/qa-init                 detect stack → qa.config.json, .qa/, CLAUDE.md import, Playwright MCP
/qa-new-pack checkout    capture product knowledge (drafted from code, confirmed with you)
```

## Daily use

| Command | What it does |
|---|---|
| `/qa-plan 1234` | Risk-based test plan from ADO story 1234 (or a branch/PR, or free text) |
| `/qa-design .qa/plans/1234.md` | Canonical YAML test cases using formal techniques |
| `/qa-run TC-CHK-001 TC-CHK-002 --env qa` | Execute (exploratory via Playwright MCP / curl, scripted via your framework, or both) → triage → report |
| `/qa-regress --base main` | Diff → impacted modules → selected cases → smoke first → run → triage → report |
| `/qa-report` | Test summary report with Go / No-go verdict |
| `/qa-ado push-cases` / `create-bug` / `publish-run` | Sync to Azure DevOps Test Plans, Bugs, Test Runs (always dry-run + confirm) |

Role subagents do the work: `qa-planner`, `qa-designer`, `qa-executor`, `qa-triager`, `qa-reporter`.

## What lands in a target repo

```
qa.config.json                 L3 config (with $schema → IntelliSense in VS Code)
CLAUDE.md                      + "@.claude/qa/QA.md" import
.mcp.json                      + playwright server (web repos)
.claude/
  settings.json                guard hook + read-only script permissions (merged)
  qa/                          contract (QA.md), schemas, templates, scripts   ← framework-owned
  skills/qa-*/                 core + adapters + ADO                           ← framework-owned
  skills/pack-<name>/          your product knowledge                          ← team-owned
  agents/qa-*.md, commands/qa-*.md                                             ← framework-owned
.qa/
  cases/<module>/<id>.yaml     test cases (commit)
  plans/                       test plans (commit)
  ado-map.json                 case ↔ ADO Test Case ids (commit)
  runs/<runId>/                run.json, evidence/, defects/, report.md (git-ignored)
```

## Guardrails

A `PreToolUse` hook (`.claude/qa/scripts/guard.mjs`) reads `qa.config.json` and:
- **denies** any browser/HTTP/shell call to an environment marked `"blocked": true` or a host in
  `guardrails.blockedHosts` (e.g. production)
- **denies** write requests (POST/PUT/PATCH/DELETE via curl, Invoke-RestMethod, httpie) to
  environments with `"allowWrite": false`
- **denies** tool calls that contain the literal value of the ADO PAT or any configured credential env var

Plus contract rules in `QA.md`: secrets only via env vars, dry-run and confirm before any ADO write, no
invented business rules, and evidence for every result.

## Azure DevOps

`ado.mjs` uses the REST API directly (no `az` CLI). Create a PAT with **Work Items (R/W)** and
**Test Management (R/W)**, then put it in `AZURE_DEVOPS_EXT_PAT` (add **Code (Read)** for PR/commit-driven regression):

```powershell
[Environment]::SetEnvironmentVariable("AZURE_DEVOPS_EXT_PAT", "<pat>", "User")   # Windows, then restart the terminal
```
```bash
export AZURE_DEVOPS_EXT_PAT=<pat>                                                 # macOS/Linux shell profile
```

| Local | ADO |
|---|---|
| `.qa/cases/*.yaml` | Test Case work items (steps, priority, tags, "Tests" link to the story), added to your suite |
| `.qa/runs/<id>/defects/*.json` | Bug work items with repro steps, severity, and evidence attachments, linked to the test case and story |
| `.qa/runs/<id>/run.json` | Test Run (planned against suite points, or standalone), outcomes, and attachments |

## Existing automation at scale (any stack; tests-only monorepos with 75+ components)

When a repo already has automated tests, and especially when it holds *only* test automation and the
application lives elsewhere (`"repoType": "tests-only"`), the framework works catalog-first. Agents never
read the repo in bulk.

```
existing tests ──index-tests──▶ .qa/catalog.json     (id, title, groups, component, build unit, stack, web/api)
test structure ─build-module-map─▶ .qa/module-map.json (components; you add areaPaths + appRepos)
core harness ─/qa-learn-conventions─▶ skills/repo-automation-conventions (house style for new tests)

ADO sprint / items / PRs ─select-regression─▶ components ─▶ tests ─make-suite─▶ per-stack runner commands
      ─▶ run ─parse-results─▶ run.json + stack traces + failure clusters ─▶ triage per cluster
      ─ado push-catalog─▶ ADO Test Cases with associated automation ─publish-run─▶ Test Plans
```

### Supported stacks (drivers)

Stack-specific knowledge lives in pluggable drivers (`.claude/qa/scripts/lib/drivers/`). Everything else
(selection, clusters, ADO, agents) is stack-neutral, and polyglot repos work out of the box.

| Driver | Frameworks | Build unit | Selection command (default) | Reports parsed |
|---|---|---|---|---|
| `java` | TestNG, JUnit 4/5 (+ Allure ids) | `pom.xml`, `build.gradle` | TestNG suite XML + `mvn -Dsurefire.suiteXmlFiles`; `-Dtest=Class#m`; Gradle `--tests` | testng-results.xml, JUnit XML |
| `js` | Playwright, Jest, Vitest, Cypress, Mocha | `package.json` | `playwright test file:line`; `jest -t` / `vitest -t` / `mocha --grep` regex; `cypress --spec` | JUnit XML, Jest/Vitest JSON |
| `python` | pytest, unittest | `pyproject.toml`, `pytest.ini`, `setup.cfg`, … | `python -m pytest <node ids>` | JUnit XML (`--junitxml`) |
| `dotnet` | NUnit, xUnit, MSTest | `*.csproj` | `dotnet test --filter FullyQualifiedName=…` | TRX, JUnit XML |
| `gherkin` | Cucumber-JVM/JS, SpecFlow/Reqnroll, behave | the unit it lives in | `feature:line` with the unit's runner | JUnit XML, TRX |

Long selections are split into several commands, each under the Windows command-line limit. Command
templates can be overridden per framework in `qa.config.json → automation.runner.commands`.

| Step | Command |
|---|---|
| One-time setup | `/qa-init` → review components → fill `areaPaths` / `appRepos` per component → `/qa-learn-conventions` |
| Domain knowledge | `/qa-new-pack commerce orders-tests payments-tests …` (group components by domain, 5–15 packs) |
| Sprint regression | `/qa-regress --ado-iteration "Commerce\\Sprint 42"` |
| PR regression | `/qa-regress --app-pr orders-api:1234` |
| Run a component or group | `/qa-run orders-tests` · `/qa-run group:smoke` |
| Link automation to ADO | `/qa-ado push-catalog --module orders-tests` (one component at a time) |

Scale rules built in: every script prints bounded summaries, and full lists go to files. Dependency
hops are capped (`regression.maxDepth`). Shared-harness changes are flagged for a full run. Failures
are grouped into clusters, so 300 red tests become a handful of root causes. Per-component work fans
out to parallel subagents.

## Extending

**New team or product:** `/qa-new-pack <name>`. Packs are plain Markdown plus one `module-map.json`,
so testers maintain them, not developers. The module map drives regression selection. Keep it current.

**Repo-specific tweaks:** put them in `qa.config.json` (`automation.*.conventions`, environments), or
add a `.qa/module-map.json` that overrides pack mappings for this repo only.

**New app type (e.g. desktop, mobile):**
1. Add `.claude/skills/qa-adapter-<type>/SKILL.md` with the same structure as the web adapter:
   exploratory tooling (MCP), scripted framework guidance, evidence, and type-specific checks
2. Add `<type>` to the `appTypes` enum in `schemas/qa.config.schema.json` and `schemas/testcase.schema.json`
3. Add detection markers to `scripts/detect-stack.mjs`
4. Mention the adapter in `agents/qa-executor.md`

Core skills, schemas, ADO sync, and reporting don't change. That's the point of the layering.

**New test stack (e.g. Go, Kotlin/Kotest, Robot Framework, Rust):** add
`.claude/qa/scripts/lib/drivers/<name>.mjs` implementing the contract documented in
`drivers/index.mjs`: `markers`, `classify`, `parse` → catalog entries, `junitKeys` (to match report
entries), `suite` (runner commands), `defaultReports`. Then register it in `drivers/index.mjs`. The
catalog, component map, regression selection, result parsing, clusters, and ADO linking pick it up
automatically.

**Core changes:** edit here, bump `.claude/qa/VERSION`, and re-run `install.mjs` on consuming repos.

## Helper scripts

All zero-install (js-yaml is vendored, MIT):

| Script | Purpose |
|---|---|
| `detect-stack.mjs` | Languages, frameworks, Java build modules and surefire wiring, test-only hint, CI, ADO from the git remote |
| `index-tests.mjs [--search …]` | Build or search the catalog of existing tests (all driver stacks) |
| `build-module-map.mjs` | Generate components (build units, namespaces, or test folders); preserves manual fields |
| `select-regression.mjs` | ADO items / sprint / app PRs / local diff / modules → components → tests (bounded summary + file) |
| `make-suite.mjs` | Per build unit and stack: runner commands (+ TestNG XML), chunked, reports into the run folder |
| `parse-results.mjs` | TestNG / JUnit XML / TRX / Jest JSON → run.json, stack traces, screenshots, failure clusters |
| `validate.mjs [files]` | Schema validation for config, module maps, cases, runs, defects |
| `new-run.mjs --env qa` | Creates a run folder (refuses blocked environments) |
| `ado.mjs <cmd> [--dry-run]` | check, get-item, changed-items, pr-files, list-plans/suites, push-cases, push-catalog, find-bugs, create-bug, publish-run |
| `guard.mjs` | The PreToolUse hook |
