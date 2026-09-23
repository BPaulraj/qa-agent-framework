---
description: Generate (or regenerate) the test summary report for a run.
argument-hint: "[runId]  (default: latest run)"
---

Report on run: $ARGUMENTS

1. Resolve the run: the given runId, else the most recent folder in `paths.runs` (default `.qa/runs/`).
2. If results still contain `failure.classification: untriaged`, run the **qa-triager** subagent first.
3. Delegate to the **qa-reporter** subagent with the runId.
4. Show the verdict line and the report path. Offer `/qa-ado publish-run <runId>`.
