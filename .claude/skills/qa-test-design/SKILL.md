---
name: qa-test-design
description: Core test design techniques (equivalence partitioning, boundary values, decision tables, state transitions, pairwise, error guessing) and how to write canonical test cases. Use whenever deriving test cases from a requirement, user story, acceptance criteria, API spec, or UI screen, or when reviewing test coverage.
---

# Test design (L0 core)

Turn a requirement into the **smallest set of cases that would catch the most likely defects**.
Coverage comes from technique, not volume.

## 1. Analyse before designing

For the item under test, list:
- **Inputs**: fields, parameters, headers, files, and implicit inputs (role, locale, time, feature flags)
- **Outputs/effects**: UI state, response, persisted data, events/messages, emails, audit logs
- **Rules**: every "if / must / only / at least / unless" in the requirement or pack `business-rules.md`
- **States**: lifecycle of the main entity (e.g. Draft → Submitted → Approved → Closed)
- **Actors**: roles and permissions
- **Integrations touched**: downstream services, DB, queues, third parties

Anything ambiguous goes in `openQuestions`, with the expectation marked `TBC`. Never invent a rule.

## 2. Pick techniques by what you see

| You see… | Use | Produces |
|---|---|---|
| Input with ranges/limits (length, amount, date, qty) | **Boundary value**: min-1, min, min+1, nominal, max-1, max, max+1 | 5–7 values per boundary |
| Input with categories (card type, country, role) | **Equivalence partitioning**: one valid per class, one per invalid class | 1 case per partition |
| Several conditions combining into an outcome | **Decision table**: each rule column = 1 case; collapse "don't care" | 1 case per rule |
| Entity with a lifecycle | **State transition**: every valid transition + key invalid ones | 0-switch coverage minimum |
| Many independent parameters (browser × role × locale) | **Pairwise**: cover every pair, not every combination | ~N² instead of N^k |
| End-to-end user goal | **Use case / journey**: main flow + each alternate + each exception | 1 case per flow |
| Past bugs, fragile areas, "what would a user do wrong?" | **Error guessing / negative** | targeted cases |
| API with a spec | **Contract**: schema, required fields, types, status codes, error format | see `qa-integration-testing` |

Always include:
- **Positive** (happy path) and **negative** (invalid input, unauthorised, conflicting state) cases
- **Empty / null / whitespace / max-length / special characters / unicode** for free-text inputs
- **Permission** checks: a role that *should not* be able to do it

## 3. Prioritise (risk = impact × likelihood)

| Priority | Meaning |
|---|---|
| P1 | Money, data loss/corruption, security, legal/compliance, core journey blocked. Always in smoke/regression. |
| P2 | Main feature behaviour and common alternates |
| P3 | Less common alternates, validation messages, cosmetic-but-visible |
| P4 | Edge cosmetics, rare combinations |

## 4. Write canonical cases

One file per case in `.qa/cases/<module>/<id>.yaml`, following `.claude/qa/schemas/testcase.schema.json`.
Start from `.claude/qa/templates/testcase.example.yaml`.

Rules for good cases:
- **Title** = behaviour being verified: `Guest cannot apply an expired promo code`, not `Promo test 3`.
- **One behaviour per case.** Several steps are fine; several unrelated verifications are not.
- **Steps are atomic actions**; **expected** results are observable and specific (exact message, status
  code, field value), never "works correctly".
- **Data is explicit**: put values in `data:` and reference them in steps as `{{data.key}}`.
  Secrets are `${ENV_VAR}`.
- **Independent**: preconditions state what must exist; don't depend on another case's leftovers.
- **Traceable**: set `requirement.adoId` when the case comes from an ADO work item.
- **Tag the technique** (`techniques:`) so coverage can be reviewed.
- `automation.status: candidate` for stable, repeatable, high-value cases, especially P1/P2 regression.

IDs: `TC-<MODULE>-<NNN>` (module uppercased, 3+ digits). Check existing files for the next free number.

After writing cases, run `node .claude/qa/scripts/validate.mjs` and fix any errors.

## 5. Coverage summary

End each design task with a table: requirement/rule → case ids → technique. Call out rules with no
coverage and why (out of scope, blocked, TBC).
