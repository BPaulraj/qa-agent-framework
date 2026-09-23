---
name: qa-functional-testing
description: Core functional testing methodology for web UI and API features, covering scope analysis, test charters, exploratory sessions, oracles, and what to verify beyond the happy path. Use when testing a new or changed feature, a user story, or acceptance criteria.
---

# Functional testing (L0 core)

Functional testing answers one question: **does the feature do what it should, and nothing it
shouldn't, for every user who can reach it?**

## Inputs to gather

1. The requirement: ADO work item (`node .claude/qa/scripts/ado.mjs get-item <id>` returns description
   and acceptance criteria), a PR description, or the user's text.
2. Pack knowledge for the affected module: `journeys.md`, `business-rules.md`, `test-data.md`,
   `glossary.md` from enabled `pack-*` skills.
3. Existing cases for the module in `.qa/cases/<module>/` (reuse them; don't duplicate).
4. For API features: the relevant operation in `automation.apiSpecs`.

## What to cover (checklist)

- **Acceptance criteria**: each criterion maps to at least one case
- **Business rules**: each rule in the pack affected by the change (decision tables where rules combine)
- **Input validation**: boundaries, partitions, required/optional, formats, and server-side validation
  (bypass the UI and call the API directly when possible)
- **Roles & permissions**: allowed roles succeed; disallowed roles are refused in both UI and API
- **State**: behaviour in each relevant entity state; invalid transitions are refused
- **Data effects**: correct persistence (re-read after write), no unintended changes to other records
- **Error handling**: clear message, no stack traces or internal ids, recoverable state
- **UI specifics** (web): see `qa-adapter-web` for navigation, refresh, back button, double-submit,
  responsive layout, and accessibility basics
- **API specifics**: see `qa-adapter-api` for status codes, schema, idempotency, and auth

## Oracles (how you know it's right)

Use them in this order: requirement/AC → pack business rules → API spec → existing behaviour in a
stable environment → consistency with similar features → user expectation. If only the last two
apply, report as **"suspected issue — needs confirmation"**, not as a bug.

## Exploratory sessions (mode: exploratory)

Run as a time-boxed charter:
```
Charter: Explore <area> with <resources/data> to discover <risk/information>
```
- Start by following the designed cases, then vary: data, order, timing, role, and interruptions
  (refresh, back, close tab, network drop)
- Take notes as you go: what you tried, what you observed, questions, and bugs
- Capture evidence for anything suspicious (screenshot plus the network response where relevant)
- Close with: coverage achieved, issues found, new case ideas (write them as cases with
  `techniques: [exploratory]`), and areas not covered

## Done criteria

- Every AC and affected business rule has a passing case, or a filed or drafted defect
- Negative and permission cases executed
- Results recorded in the run's `run.json` with evidence
- Open questions listed for the product owner
