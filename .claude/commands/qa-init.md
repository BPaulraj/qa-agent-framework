---
description: Initialise (or update) the QA agent framework in this repo. Detects the stack, then writes qa.config.json, .qa/, the CLAUDE.md import, and the Playwright MCP config.
argument-hint: "[--update]"
---

Initialise the QA agent framework for this repository. $ARGUMENTS

## Steps

1. **Detect.** Run `node .claude/qa/scripts/detect-stack.mjs` and read the JSON.
   If `existingQaConfig` is true, read `qa.config.json` and switch to update mode: only fill gaps or
   change what the user asks for, and never discard existing values.

2. **Show findings** in a short table: languages, app frameworks, suggested app types, web/API
   automation frameworks and test dirs, API specs, BDD, CI, ADO org/project from the git remote,
   existing packs.

3. **Ask only what you couldn't detect** (use AskUserQuestion; batch related questions):
   - App types in scope (web / api). Pre-select the suggestions.
   - Environments: names and base URLs (web and/or API). Which is the default? Which are read-only
     (`allowWrite: false`)? Which must never be touched (`blocked: true`, e.g. prod)? Also ask for host
     globs to block.
   - Auth: **names** of env vars that hold test credentials/tokens per environment (never values)
   - Automation per app type: confirm the detected framework, language, testDir, and runCommand. If none
     is detected, set `"framework": "none"` (the executor will propose one later).
   - Execution mode: exploratory / scripted / both (default both)
   - Packs: existing `pack-*` to enable, or offer to create one now with `/qa-new-pack`
   - Azure DevOps: confirm organization/project (pre-fill from git remote), area path, iteration path,
     test plan and suite ids (optional; can be discovered later with `ado.mjs list-plans`), PAT env var
     name (default `AZURE_DEVOPS_EXT_PAT`)

4. **Write `qa.config.json`** at the repo root, starting from
   `.claude/qa/templates/qa.config.example.json`, with `"$schema": "./.claude/qa/schemas/qa.config.schema.json"`
   so VS Code gives IntelliSense. Remove example values that don't apply.

5. **Create folders**: `.qa/cases/`, `.qa/plans/`, `.qa/runs/`. Add these lines to `.gitignore`
   (create it if missing, and don't duplicate lines that are already there):
   ```
   # QA framework: run artefacts and MCP scratch
   .qa/runs/
   .qa/mcp-output/
   ```
   (`.qa/cases`, `.qa/plans` and `.qa/ado-map.json` are meant to be committed.)

6. **CLAUDE.md**: make sure the repo-root `CLAUDE.md` contains the line `@.claude/qa/QA.md`.
   Append it under a `## QA framework` heading, or create the file with that content if missing. Don't
   modify anything else in an existing CLAUDE.md.

7. **Playwright MCP** (only if `web` is in appTypes): merge this server into the repo-root `.mcp.json`
   (create it if missing, and keep any existing servers):
   - Windows (native):
     `"playwright": { "command": "cmd", "args": ["/c", "npx", "-y", "@playwright/mcp@latest", "--output-dir", ".qa/mcp-output"] }`
   - macOS/Linux/WSL:
     `"playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--output-dir", ".qa/mcp-output"] }`
   Tell the user to restart Claude Code and approve the server when prompted.

7b. **Existing automation (any stack): catalog set-up.** Do this whenever the repo already has automated
   tests. It's essential for automation monorepos (repo holds only tests), and useful for app repos too.
   Supported stacks come from the drivers in `.claude/qa/scripts/lib/drivers/`: Java (TestNG/JUnit),
   JS/TS (Playwright, Jest, Vitest, Cypress, Mocha), Python (pytest/unittest), .NET (NUnit/xUnit/MSTest),
   and Gherkin (Cucumber/SpecFlow/Reqnroll/behave). Polyglot repos are fine.
   - Set `"repoType"`: `tests-only` when the application lives in other repos (the `java.repoTypeHint`
     helps for Java), else `app-and-tests`. Confirm with the user.
   - Build the catalog and components: `node .claude/qa/scripts/build-module-map.mjs`. It picks a
     strategy automatically: `build` (one component per Maven/Gradle module, package.json workspace,
     csproj, or Python project), `package` (Java/.NET namespaces), or `path` (test folders, merged
     across stacks). Show the summary (`byDriver` via `index-tests.mjs`). If the component names don't
     match how the team talks, retry with `--strategy package|path` or `--strategy folder --root <dir>`.
   - **Runner overrides** (`automation.runner`): the drivers generate sensible default commands per
     stack. Only override what differs, using `automation.runner.commands.<kind>`:
     - Java/Maven: if `java.surefire.suiteXmlProperties` has a property (e.g. `suiteXmlFile`), set
       `commands.testng` to `mvn -q {pl} test -D<property>={suiteXml} -DfailIfNoTests=false`. If
       `hardcodedSuiteXml` is true, the pom must expose a property first. Gradle uses `--tests` filters automatically.
     - JS: the defaults are `npx playwright test <file:line>` (JUnit report), `npx jest -t` (JSON report),
       `npx vitest run -t` (JUnit), `npx mocha --grep` (xunit), and `npx cypress run --spec`. Switch
       `npx` for `pnpm exec`/`yarn` if the repo uses those.
     - Python: `python -m pytest <node ids> --junitxml`. Change it to `poetry run pytest` /
       `uv run pytest` if needed.
     - .NET: `dotnet test <csproj> --filter FullyQualifiedName=... --logger trx`
     - Add environment/browser flags the team always passes (e.g. `-Denv=qa`, `--project=chromium`, `ENV=qa`)
     - `evidenceDirs`: ask where failure screenshots and logs land (e.g. `**/target/screenshots/*.png`,
       `**/test-results/**/*.png`, `**/TestResults/**/*.png`)
   - `appRepos`: ask which application repos (ADO Git repo names) these tests cover
   - Add `.qa/catalog.json`, `.qa/selections/` and `.qa/suites/` to `.gitignore` (regenerated), and
     keep `.qa/module-map.json` committed
   - Explain the one manual step that makes regression work: per component, fill `areaPaths` (ADO area
     path globs) and/or `appRepos` (`[{ "repo": "orders-api", "paths": ["src/main/**"] }]`) in
     `.qa/module-map.json`. Offer to draft `areaPaths` from `ado.mjs changed-items --iteration <current sprint>`
     (see `byAreaPath`) and confirm them with the user.
   - Suggest `/qa-learn-conventions` next

8. **Validate**: run `node .claude/qa/scripts/validate.mjs` and fix config errors.
   If ADO is configured and the PAT env var is set, run `node .claude/qa/scripts/ado.mjs check`.
   Otherwise explain how to create the PAT (see the `qa-ado-integration` skill).

9. **Summarise**: files created or changed, anything still TODO (e.g. PAT, pack content, plan id),
   and suggested next steps: `/qa-new-pack <name>`, `/qa-plan <ADO id>`, `/qa-regress`.
