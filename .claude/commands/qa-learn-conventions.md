---
description: Learn this repo's automation house style (core harness, base classes, page objects, API clients, data, naming) into a repo-automation-conventions skill, so generated tests look like the team wrote them.
argument-hint: "[--refresh]"
---

Learn the automation conventions of this repository. $ARGUMENTS

The output is `.claude/skills/repo-automation-conventions/SKILL.md` (L1.5), started from
`.claude/qa/templates/conventions/SKILL.md`. In refresh mode, update the existing file in place and
keep anything a human edited.

## Scale rules
Never read the whole repo. Use the catalog, the module map, and targeted reads. Fan out with parallel
**Explore** subagents and have each return a short structured summary, not file dumps.

## Steps

1. Read `qa.config.json`, `.qa/module-map.json` (`sharedPaths` = the shared core harness), and the
   catalog summary (`node .claude/qa/scripts/index-tests.mjs` if the catalog is missing).
2. **Core harness** (one Explore subagent per shared path, max 4): base test classes, driver/session
   factory, API client wrappers, config and environment loading, data builders and test data sources,
   assertion helpers, reporting (Allure/Extent), waits and retry utilities, listeners, and
   screenshot-on-failure. For each, return the class name, package, what it's for, and how tests use it,
   with one short usage snippet.
3. **Representative components** (Explore subagents, 3–5 components chosen for variety: the largest
   UI, the largest API, one Cucumber if present, one recent): folder layout, page object pattern,
   test class structure, naming (classes, methods, groups), data providers, how environments and
   credentials are read, and how tests are tagged (groups/priority). Also report which conventions
   are consistent across components and where they diverge.
4. **Execution facts**: how the team runs a single test, a file/class, a tag/group, and a component.
   Check the README, CI YAML (`azure-pipelines*.yml`), and runner configs (`testng*.xml`,
   `playwright.config.*`, `jest.config.*`, `vitest.config.*`, `cypress.config.*`, `pytest.ini`/`pyproject.toml`,
   `*.runsettings`). Then generate a sample with
   `node .claude/qa/scripts/make-suite.mjs --tests <one catalog id>` and compare its command with how the team
   runs tests. Put any differences (package manager, env flags, projects/browsers, wrappers) into
   `qa.config.json → automation.runner.commands.<kind>`.
5. Write the skill from the template. Include short, real code snippets (≤ 15 lines each) from the repo,
   and cite file paths. Mark anything uncertain `(verify)`.
6. Show the user a summary of the conventions, the divergences between components, and the `(verify)`
   items to confirm.
