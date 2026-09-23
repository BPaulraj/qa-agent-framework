---
description: Azure DevOps actions. Read work items, sprint changes and PR files; push test cases; link existing automation (push-catalog); file bugs; publish runs. Always dry-run first and confirm.
argument-hint: "check | get-item <id> | changed-items --iteration <path> | pr-files --repo r --pr n | list-plans | list-suites | push-cases [paths] | push-catalog --module <m> | create-bug [defect files | runId] | publish-run <runId>"
---

Azure DevOps action: $ARGUMENTS

Follow `.claude/skills/qa-ado-integration/SKILL.md`.

1. If `qa.config.json → ado` is missing, help the user fill it in (organization, project, area and
   iteration paths, plan and suite ids) and make sure the PAT env var is set. Never ask them to paste
   the PAT into the chat.
2. Read-only actions (`check`, `get-item`, `changed-items`, `pr-files`, `list-plans`, `list-suites`,
   `find-bugs`): run `node .claude/qa/scripts/ado.mjs <action> ...` and present the result readably.
3. Writing actions (`push-cases`, `push-catalog`, `create-bug`, `publish-run`):
   - Resolve targets:
     - `create-bug` with a runId: use every draft in `<runDir>/defects/` without an `adoBugId`, and run
       `find-bugs` on each draft's key terms to show possible duplicates
     - `push-catalog`: **one component (or a few) at a time**. It creates one ADO Test Case per
       automated test, linked through the associated-automation fields. For a large component, the
       default batch is 500; re-run to continue.
   - Run with `--dry-run` and show a compact summary: what gets created or updated, counts, links,
     attachments, and anything skipped with the reason
   - **Ask for explicit confirmation**
   - Run for real, then show the created/updated counts and URLs
   - After `create-bug`, set each run result's (or cluster's) `defect` field to the new bug id
4. On errors, use the Troubleshooting section of the skill. Don't retry writes blindly.
