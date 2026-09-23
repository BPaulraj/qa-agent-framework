---
description: Create a product/team knowledge pack (journeys, business rules, test data, glossary, and a module map for app-and-tests repos) by reading the codebase per component and interviewing the user.
argument-hint: "<pack-name> [components...]  e.g. commerce orders-tests payments-tests checkout-ui-tests"
---

Create a product/team pack: $ARGUMENTS

A pack is L2 **business** knowledge: what makes the generic QA agent behave like a tester on *this*
team. In a repo with many components, **group components into domain packs** (typically 5–15 packs for
75+ components, one per team or business domain), not one pack per component.

1. Normalise the name to `pack-<kebab-name>`. If `.claude/skills/pack-<name>/` exists, switch to
   update mode and only add to or refine it.
2. **Decide the components in scope**: those listed in the arguments; otherwise propose a grouping
   from `.qa/module-map.json` (names, `owner`, and `areaPaths` prefixes) and confirm it with the user.
   Set `"pack": "pack-<name>"` on those entries in `.qa/module-map.json`.
3. Copy `.claude/qa/templates/pack/` to `.claude/skills/pack-<name>/` and replace `{{PACK_NAME}}`,
   `{{PACK_TITLE}}`, and `{{TEAM}}`.
   - **tests-only repos**: delete the pack's `module-map.json`. Components live in `.qa/module-map.json`.
   - **app-and-tests repos**: keep it and fill it from the source structure (paths, dependsOn, journeys).
4. **Draft from the code, one component at a time.** Never read everything at once. Launch parallel
   **Explore** subagents (one per component, in batches of up to 5) and ask each for a bounded summary:
   - user journeys exercised (from test class/method names, descriptions, Cucumber scenarios)
   - business rules asserted (expected values, validation messages, status codes, boundaries), with
     file:line sources
   - test data and accounts used (env var names only)
   - domain terms
   Use the catalog to point them at the right files:
   `index-tests.mjs --module <component> --limit 200`.
5. Merge the summaries into `journeys.md`, `business-rules.md` (ids `BR-<MOD>-NN`, each with a source;
   rules inferred from test assertions are marked *(inferred, confirm)*), `test-data.md`, and
   `glossary.md`. Deduplicate across components.
6. **Interview the user**: the top journeys, critical rules, fragile areas and escaped defects (for the
   SKILL.md risk section), environment quirks, and who owns TBC questions.
7. Add `pack-<name>` to `qa.config.json → packs`. Run `validate.mjs`.
8. Summarise the pack, the components covered, and the items marked *(inferred, confirm)* that need
   review by a domain expert.
