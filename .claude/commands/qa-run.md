---
description: Execute tests (catalog tests by component/group/search, YAML cases by id/module/tag, or a selection file) against an environment, then triage failures and report.
argument-hint: "<component | group:<g> | search:<words> | case ids | selection file> [--env <name>] [--mode exploratory|scripted|both]"
---

Run tests: $ARGUMENTS

1. If `qa.config.json` is missing, stop and suggest `/qa-init`.
2. **Resolve the selection** without reading test sources:
   - Catalog tests (existing automation): component name, `group:<g>`, or `search:<words>`, via
     `node .claude/qa/scripts/index-tests.mjs --module/--group/--search` (bounded output; use counts)
   - YAML cases: ids, `module`, `tag:<t>`, `priority:P1`, or a folder in `.qa/cases/`
   - A selection file from `select-regression.mjs`

   Show the counts per component and the environment. Confirm with the user if more than 200 tests,
   or any writes to a shared environment, are involved.
3. **Create the run**: `node .claude/qa/scripts/new-run.mjs --env <env> --name "<short name>" --trigger manual`
4. **Execute**: delegate to the **qa-executor** subagent with the selection, runId, environment, and mode.
   - Catalog tests: `make-suite.mjs` → run commands → `parse-results.mjs` (the executor handles this)
   - Large mixed selections: you may run web and API YAML cases in parallel executors. Each writes
     `<runDir>/partial-<name>.json`; merge their `results` into `run.json` afterwards and delete the
     partials. (`parse-results.mjs` merges scripted results into `run.json` itself.)
5. **Triage**: if there are failures, delegate to **qa-triager** with the runId. It works per cluster.
6. **Report**: delegate to **qa-reporter** with the runId.
7. **Show the user**: the verdict, counts, top failure clusters, and defect drafts. Offer:
   - `/qa-ado create-bug` for drafted defects (dry run first; confirmation required)
   - `/qa-ado publish-run <runId>`
   - re-running failed or blocked tests after fixes (`make-suite.mjs --tests <ids>`)
