---
name: qa-defect-reporting
description: Core failure triage and defect reporting. Classify failures (product bug, test bug, environment, test data, flaky, requirement gap), isolate and minimise repro steps, set severity and priority, and write defect drafts ready for Azure DevOps. Use when a test fails, when something unexpected is observed, or when asked to write a bug.
---

# Triage & defect reporting (L0 core)

## 1. Triage every failure before reporting

Work through these questions in order. The first "yes" is usually the classification.

| Question | Classification |
|---|---|
| Is the environment healthy? (smoke passes, services up, no 502/503, correct build deployed) | `environment` if not |
| Did the test's preconditions or data hold? (user exists, stock available, data not consumed by another run) | `test-data` if not |
| Is the test itself right? (stale locator, wrong wait, wrong expected value vs. current requirement, test-order dependency) | `test-bug` |
| Does it pass on an isolated re-run with no changes? | `flaky` |
| Is the requirement silent or contradictory about this behaviour? | `requirement-gap` |
| Does the app contradict the requirement, business rule, or contract? | `product-bug` |

Record `classification`, `confidence` (high/medium/low), and a one-to-three-sentence `reasoning` in the
result's `failure` block. Low confidence means ask the user; don't file.

**Clusters.** Scripted runs are grouped by `parse-results.mjs` into `run.json → clusters` (same
exception and normalised message). Triage the cluster once with 1–3 samples, then apply the
classification to all its results. One real bug produces **one** defect draft per cluster
(`defects/cluster-<id>.json`) listing the affected tests, not one bug per test. Watch for clusters that
span many components; they usually point to an environment issue or a core-harness change.

Only `product-bug` (and a confirmed `requirement-gap`, filed as a question) becomes a defect draft.
`test-bug` results in a proposed test fix. `environment` results in an environment note in the report.

## 2. Isolate and minimise

- Reproduce manually or with exploratory tooling. Don't rely only on the script's report.
- Remove steps until the bug disappears, then put the last one back. Aim for the shortest repro.
- Vary one thing at a time to find the boundary: data, role, browser, environment, and first time vs.
  repeat.
- Check the API underneath a UI bug: does the API return the wrong data (backend) or does the UI render
  correct data wrongly (frontend)? Say which in the defect.
- Search for duplicates before drafting: `node .claude/qa/scripts/ado.mjs find-bugs --text "<keyword>"`.

## 3. Severity vs. priority

| Severity (impact) | Guideline |
|---|---|
| 1 - Critical | Data loss or corruption, security hole, payment wrong, core journey blocked with no workaround, crash |
| 2 - High | Major feature broken, workaround exists but is painful; wrong business result |
| 3 - Medium | Feature partially wrong, reasonable workaround; significant UX or validation issue |
| 4 - Low | Cosmetic, typo, minor inconsistency |

Priority (1–4) is urgency to fix. Suggest a value, but the team decides. Default is priority = severity
number, bumped up for release blockers and high-traffic paths.

## 4. Write the defect draft

Save it as `.qa/runs/<runId>/defects/<caseId>.json` (or `adhoc-<slug>.json` outside a run), following
`.claude/qa/schemas/defect.schema.json`.

- **Title**: `[Module] <symptom> when <condition>`. Example:
  `[Checkout] Order total ignores promo discount when cart has mixed-VAT items`
- **Steps**: numbered, atomic, with the exact data used (no secrets; name the env var instead)
- **Expected**: cite the source ("per AC #3 of story 1234" or "per pack business rule BR-CHK-07")
- **Actual**: exact message, status code, value, or visual. Quote it.
- **Evidence**: screenshot at the failure point, API request/response (sanitised), console errors,
  trace. Paths are relative to the run folder.
- **Environment/build/browser**: always
- **Frequency**: always / intermittent (x of y) / once
- **Links**: `caseId`, `adoTestCaseId` (from `.qa/ado-map.json`), `requirementAdoId`
- **Notes**: frontend vs. backend hint, suspected area, workaround

Sanitise everything: no tokens, cookies, passwords, or personal data from real users.

## 5. Filing in Azure DevOps

Show the user the draft(s), then run `ado.mjs create-bug <file> --dry-run`, and file only after the
user confirms. See `qa-ado-integration`. Put the returned bug id in the run result's `defect` field.
