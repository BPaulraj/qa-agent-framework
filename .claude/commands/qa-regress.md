---
description: Impact-based regression. Maps changes (ADO work items, sprint, app-repo PRs/commits, local diff, or named components) to components and tests, runs smoke first, then triages by failure cluster and reports.
argument-hint: "[--ado-iteration \"<path>\" | --ado-ids 1,2 | --ado-query <id> | --app-pr repo:id | --modules a,b | --base <branch>] [--tier smoke|targeted|full] [--env <name>]"
---

Run regression: $ARGUMENTS

Follow `.claude/skills/qa-regression-testing/SKILL.md`.

1. If `qa.config.json` is missing, stop and suggest `/qa-init`.
2. **Work out the change source** from the arguments or by asking:
   - Sprint/release → `--ado-iteration "<Project\\Sprint N>"` (optionally `--ado-area`)
   - Specific stories/bugs → `--ado-ids`
   - A saved ADO query → `--ado-query <id>`
   - App PRs/commits → `--app-pr repo:id` / `--app-commit repo:sha`
   - Known components → `--modules`
   - Changes to this repo (test code or app code in an app-and-tests repo) → `--base <branch>`

   Sources can be combined.
3. **Tier** (default `targeted`):
   - `smoke`: tests/cases in the always-include groups (`regression.alwaysInclude.tags`)
   - `targeted`: `node .claude/qa/scripts/select-regression.mjs <inputs>`
   - `full`: every enabled catalog test (`make-suite.mjs --module <all>`) plus P1/P2 YAML cases
4. For `targeted`, **review the summary with the user.** Don't open the selection file in full.
   - Impacted components and why (ADO item, PR, dependency hop), with counts per component
   - `unmapped.adoItems`: stories that matched no component. Propose `areaPaths`/`adoTags`
     additions to `.qa/module-map.json`, or ask which component each belongs to.
   - `unmapped.appFiles`: app changes no component claims. Propose `appRepos` paths.
   - `broadImpact` (shared framework code changed) or a high impacted ratio: recommend `full`.
   - Coverage gaps: an impacted component or story with no tests. Offer `/qa-design`.

   Get a go-ahead on the scope.
5. Create the run with `new-run.mjs --trigger regression` and copy the selection summary into
   `run.json → selection` (inputs, impacted components, counts, selection file path).
6. **Smoke first**: run the always-include subset (e.g. `make-suite.mjs --group smoke --run <id>`). If it
   fails broadly (environment down, login broken), stop, mark the rest `blocked`, and report.
7. **Execute** via **qa-executor**: `make-suite.mjs --selection <file> --run <id>`, then run the commands
   (per build module, sequential unless `automation.runner.parallelModules` > 1), then
   `parse-results.mjs --run <id>`. Manual/YAML cases in the selection run exploratorily.
8. **Triage** via **qa-triager**, per failure cluster. **Report** via **qa-reporter**.
9. Show the verdict, clusters, and defects. Offer ADO filing and publishing (`/qa-ado`). End with the
   regression-pack health suggestions: module-map fixes for unmapped items, tests for escaped defects,
   and flaky tests to stabilise.
