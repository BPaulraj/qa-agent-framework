---
description: Design canonical test cases from a plan, ADO work item, or scope, and validate them.
argument-hint: "<plan path | ADO id | scope description>"
---

Design test cases for: $ARGUMENTS

1. If `qa.config.json` is missing, stop and suggest `/qa-init`.
2. If the argument is an ADO id and no plan exists for it, suggest `/qa-plan` first, but proceed if the
   user wants to go straight to cases.
3. Delegate to the **qa-designer** subagent with the input.
4. Show the user the created cases (id, title, priority, type), the coverage table, and gaps and open questions.
5. Offer next steps:
   - `/qa-run <ids or module>` to execute
   - `/qa-ado push-cases` to create the Test Cases in Azure DevOps (dry run first)
