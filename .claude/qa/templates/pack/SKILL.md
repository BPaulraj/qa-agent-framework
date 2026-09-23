---
name: {{PACK_NAME}}
description: Product knowledge pack for {{PACK_TITLE}} ({{TEAM}}), covering user journeys, business rules, test data, module map, glossary, and known risks. Use whenever planning, designing, executing, or triaging tests that touch {{PACK_TITLE}}.
---

# {{PACK_TITLE}} pack (L2)

Owner: {{TEAM}} · Reviewed: {{YYYY-MM-DD}}

This pack overrides generic core assumptions. When a rule here conflicts with a core skill, **this pack wins**.
`qa.config.json` wins over this pack.

## Files

| File | Use it for |
|---|---|
| [journeys.md](journeys.md) | End-to-end user flows. Keys are referenced by test cases (`journey:`) and the module map |
| [business-rules.md](business-rules.md) | Expected behaviour (the test oracle). Cite rule ids in expected results and defects |
| [test-data.md](test-data.md) | Accounts (env var names only), fixtures, sandbox cards, data setup/cleanup |
| [module-map.json](module-map.json) | Code paths → modules → journeys, and dependencies. Drives regression selection |
| [glossary.md](glossary.md) | Domain terms, so cases and defects use the team's language |

## Risk profile

Areas where bugs have escaped before, or that are fragile. Always consider these in plans and regression:

- {{e.g. Promo codes combined with multi-currency carts (3 escapes in 2025)}}
- {{e.g. Payment provider timeouts: order stuck in PENDING}}

## Environment quirks

- {{e.g. QA payments sandbox resets nightly at 02:00 UTC; tests fail during the reset}}
- {{e.g. Emails in QA go to Mailhog at https://mail.qa.example.com}}

## Conventions

- Case id prefix per module: {{e.g. checkout → TC-CHK, payments → TC-PAY}}
- {{Any team-specific test process: Definition of Done, who confirms TBC questions, triage rota}}
