---
name: qa-regression-testing
description: Core regression testing methodology covering impact analysis from code changes, risk-based test selection, suite tiers (smoke, targeted, full), flaky-test handling, and keeping the regression pack healthy. Use when verifying that a change didn't break existing behaviour, before a release, or when selecting tests for a PR.
---

# Regression testing (L0 core)

Regression testing is a **selection problem**. The goal is maximum confidence that nothing that
worked before is broken, within the available time.

## Tiers

| Tier | When | Content |
|---|---|---|
| **Smoke** | Every deploy, first thing | Cases tagged `smoke`: app up, login, one step of each P1 journey. Minutes. |
| **Targeted** | Every PR / change | Impact-selected cases (below) + always-include set |
| **Full** | Release candidate, major refactor, or unmapped changes | All `regression`-typed and P1/P2 cases |

If smoke fails, **stop** and report an environment or build problem. Don't run further tiers.

## Impact analysis

Where "what changed" comes from depends on the repo type:

| Repo type | Change sources | Mapped to components via |
|---|---|---|
| app-and-tests | this repo's diff (`--base`) | `paths` (app code) / `testPaths` |
| tests-only (automation monorepo) | ADO items (`--ado-ids`, `--ado-iteration`, `--ado-query`), their linked PRs/commits, app PRs/commits (`--app-pr`, `--app-commit`), plus this repo's diff for test-code changes | `areaPaths` / `adoTags` (ADO items), `appRepos` (app files), `testPaths` (test code) |

1. Run the selector with the relevant inputs (combinable):
   ```
   node .claude/qa/scripts/select-regression.mjs --ado-iteration "Proj\\Sprint 42" --base main
   ```
   It maps changes → components, follows `dependsOn` for `--max-depth` hops (default 1), adds
   always-include groups/tags, and selects catalog tests (existing automation) plus YAML cases.
   Changed test files select their own tests directly. Changes under `sharedPaths` (the core
   harness) are flagged as broad impact. The full list goes to `.qa/selections/<ts>.json`, and stdout
   shows a bounded summary.
2. **Review the output. Don't apply it blindly:**
   - `unmapped.adoItems`: stories no component claims. Ask which component each belongs to, then add
     the area path glob (`areaPaths`) or tag (`adoTags`) to that component in `.qa/module-map.json`, so
     the next run maps it automatically.
   - `unmapped.appFiles` / `unmapped.localFiles`: add `appRepos` paths / `testPaths`, or accept as noise
   - `broadImpact` or a high impacted ratio (> 30% of components): recommend the full tier
   - For app-and-tests repos, read the risky diff hunks (from `--stat` first) for signals the map can't
     see: validation, SQL, feature flags, auth checks, date/currency handling, error handling, removed code.
3. Add **risk-based extras**: modules with recent defects, complex business rules touched, or
   integrations touched (`qa-integration-testing`).
4. If there are no cases for an impacted module or rule, flag it as a **coverage gap** and offer to
   design cases (`/qa-design`).
5. Record the selection rationale in `run.json → selection` (changed files count, impacted
   modules, why each extra was added).

## Execution order

P1 first, then P2 and the rest. Run scripted cases in bulk (fast feedback), then exploratory cases for
anything manual or anything the scripts don't cover. Exploratory time should focus on changed areas.

## Failures and flakiness

- A failure is **not** a bug until triaged (`qa-defect-reporting`, triage section). Large runs are
  triaged per **failure cluster** (`run.json → clusters`, from `parse-results.mjs`).
- Before calling a failure flaky, re-run it **once**, in isolation. Pass-on-retry means `flaky`:
  record it and don't file a product bug, but track it. Two flaky results for the same case mean you
  should propose a fix to the test (wait strategy, data isolation, locator).
- Compare with the base: if the same case also fails on the base branch or in the stable environment,
  it isn't a regression from this change. Report it separately.

## Keeping the regression pack healthy

At the end of a regression cycle, suggest:
- New cases for escaped defects (a bug found late should get a regression case)
- Promotion of stable manual P1/P2 cases to `automation.status: candidate`
- Retirement or merging of cases that duplicate each other or test removed features
- Module map updates for unmapped files that recur
