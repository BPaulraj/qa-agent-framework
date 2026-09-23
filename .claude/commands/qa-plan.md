---
description: Create a risk-based test plan from an ADO work item id, a PR/branch, or a feature description.
argument-hint: "<ADO id | PR/branch | description>"
---

Create a test plan for: $ARGUMENTS

1. If `qa.config.json` is missing, stop and suggest `/qa-init`.
2. Work out what the input is:
   - A number (or `#1234`, or an ADO URL) is an ADO work item
   - An iteration path or "sprint N" means all items in that ADO iteration
   - `repo:PR` / an ADO PR URL means an app-repo pull request
   - A branch name or `--base <b>` means a change in this repo (diff vs. base)
   - Anything else is a free-text feature description
3. Delegate to the **qa-planner** subagent with the input, its type, and any extra context from the user.
4. When it returns, show the user the plan path, the summary, the risk table highlights, and the
   **open questions**. Offer next steps: answer the questions, then `/qa-design <plan path>`.
