---
name: qa-ado-integration
description: Azure DevOps integration for QA, covering reading user stories/PBIs and acceptance criteria, creating and updating Test Cases in Test Plans, filing Bugs with evidence, and publishing test run results. Use whenever a task mentions an ADO work item id, Azure DevOps, Test Plans, or filing or publishing to ADO.
---

# Azure DevOps integration

All calls go through `node .claude/qa/scripts/ado.mjs`, which uses the ADO REST API with a PAT. The
`az` CLI isn't needed.

## Setup (once per machine / repo)

1. **PAT**: in ADO, go to User settings → Personal access tokens. Scopes: **Work Items (Read & Write)**,
   **Test Management (Read & Write)**, and **Code (Read)** (for PR/commit-driven regression). Store it in the env var named by `ado.patEnvVar`
   (default `AZURE_DEVOPS_EXT_PAT`), e.g. in the user's shell profile or Windows user environment
   variables. **Never** put it in files or commands. The guard hook blocks its literal value.
2. **Config**: `qa.config.json → ado`: `organization` (`https://dev.azure.com/<org>`), `project`,
   optional `areaPath`, `iterationPath`, `testPlanId`, `testSuiteId`, `bugDefaults`.
   Discover ids with `ado.mjs list-plans` and `ado.mjs list-suites --plan <id>`.
3. Verify with `ado.mjs check`.

## Commands

| Need | Command | Writes? |
|---|---|---|
| Read a story/PBI/bug (title, description, acceptance criteria, links) | `get-item <id>` | no |
| Sprint/query/ids → items with area path, tags, linked PR/commit counts | `changed-items --iteration "<path>" [--area "<path>"]` / `--ids` / `--query` | no |
| Files changed by an app-repo PR | `pr-files --repo <name> --pr <id>` | no |
| Find plans / suites | `list-plans`, `list-suites --plan <id>` | no |
| Create/update Test Cases from `.qa/cases` | `push-cases [files/dirs] [--suite <id>]` | **yes** |
| Create Test Cases for **existing automated tests** (catalog), linked via associated automation | `push-catalog --module <m> [--suite <id>] [--limit 500]` | **yes** |
| Look for duplicate bugs | `find-bugs --text "<keywords>"` | no |
| File a bug from a defect draft (with evidence attachments) | `create-bug <defect.json>` | **yes** |
| Publish run results to ADO Test Runs | `publish-run <runId>` | **yes** |

Every writing command supports `--dry-run`.

## Confirmation rule (mandatory)

For every writing command:
1. Run it with `--dry-run` and show the user a short summary: what will be created or updated, and how many
2. Get an explicit "yes" for that batch
3. Run it for real and report the ids/URLs returned

## Mappings

**Test case → ADO Test Case**
- Title → `<caseId> <title>`; steps → `Microsoft.VSTS.TCM.Steps` (action / expected result)
- Preconditions, data, cleanup → Description; priority P1–P4 → Priority 1–4
- Tags: `qa:<caseId>`, `qa-<type>`, `module:<m>`, `journey:<j>`, `automated`, plus case tags
- `requirement.adoId` → "Tests" link to the story (appears on the story's Tested By tab)
- Area/Iteration from config. Added to `--suite` / `ado.testSuiteId` when a plan is configured.
- The id mapping is stored in `.qa/ado-map.json`. **Commit it.** It is recoverable via the `qa:<caseId>` tag.

**Defect draft → ADO Bug**
- Title, Repro Steps (preconditions, steps, expected, actual, frequency), System Info
  (environment/build/browser), Severity, Priority, Tags (`qa-framework`, `module:<m>`, bug defaults)
- Evidence files are uploaded as attachments; linked Related to the test case and the requirement
- An exact-title open duplicate blocks creation unless you pass `--force`. The bug id is written back
  into the draft (`adoBugId`).

**Catalog test → ADO Test Case (linking existing automation, `push-catalog`)**
- One Test Case per enabled automated test: title from the test's description, display name, docstring,
  or title (else the humanised method name); description carries the test id, file, component, and groups
- Associated automation: `AutomatedTestName` (Java `fqcn.method`, .NET FQN, pytest node id, JS
  `file#describe > title`, Gherkin `feature:line`), `AutomatedTestStorage` (build unit),
  `AutomatedTestType` (TestNG, JUnit, Playwright, Jest, pytest, NUnit, xUnit, MSTest, Cucumber, ...), and a
  generated `AutomatedTestId`
- Tags `qa-automated`, `module:<component>`, `app:<web|api>`, and the test groups
- Mapping in `.qa/ado-map.json → catalog`. Done in batches per component (the map is saved every 25
  items, so an interrupted run resumes safely).
- Roll out one component at a time, and agree the target suite structure with the team first (e.g. one
  static suite per component under a regression plan)

**Run → ADO Test Run**
- With `testPlanId` + `testSuiteId`: a planned run against the suite's test points (shows in the
  Test Plans progress report). Otherwise: a standalone automated run.
- Outcome mapping: passed → Passed, failed → Failed, blocked → Blocked, skipped → Not Executed
- Comment carries notes, triage classification, and defect id; evidence is attached per result
- The ADO run id/url is written back into `run.json → ado`

## Typical flows

- **Story → tests**: `get-item <storyId>` → `/qa-plan` → `/qa-design` (cases get
  `requirement.adoId`) → `push-cases --dry-run` → confirm → `push-cases`
- **After a run**: triage → defect drafts → `find-bugs` → `create-bug --dry-run` → confirm → file;
  then `publish-run --dry-run` → confirm → publish

## Troubleshooting

- `401` or an HTML response: the PAT is missing, expired, or lacks scopes
- `TF401320` / "field X is required": the ADO process has custom required fields. Ask the user for
  values, then add them to `ado.bugDefaults` (extend the script's field list if needed).
- "Invalid area/iteration path": copy the exact path from ADO (Project Settings → Boards), using backslashes
  in JSON as `\\`
- A case isn't in a planned run: it isn't in the suite. Run `push-cases --suite <id>` first.

An official Azure DevOps MCP server (`@azure-devops/mcp`) also exists. Teams may add it for broader ADO
queries. This framework's writes still go through `ado.mjs` so they stay consistent and dry-runnable.
