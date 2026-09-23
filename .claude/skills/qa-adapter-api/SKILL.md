---
name: qa-adapter-api
description: REST/GraphQL API adapter (L1) covering how to call and verify APIs, both exploratory via curl and scripted in the repo's framework (Playwright request, RestAssured, supertest, pytest+requests, RestSharp, Karate, Postman/Newman). Covers auth, contract/schema checks, status codes, security, idempotency, and evidence. Use whenever executing or automating a test with appType api.
---

# API adapter (L1)

Read `qa.config.json → environments.<env>.apiBaseUrl`, `environments.<env>.auth`, `automation.api`,
and `automation.apiSpecs` first. The guard hook blocks blocked hosts, and blocks write verbs against
read-only environments.

## A. Exploratory execution (curl)

Use `curl` in Bash (available in Git Bash on Windows). Reference secrets only as env vars:

```bash
RUN=.qa/runs/<runId>/evidence
curl -sS -X POST "$API/orders" \
  -H "Authorization: Bearer $QA_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"sku":"qa-auto-<runId>-1","qty":2}' \
  -D "$RUN/TC-ORD-004-step2.headers.txt" -o "$RUN/TC-ORD-004-step2.body.json" \
  -w '%{http_code} %{time_total}s\n'
```

- Save headers and body for every verification step (that's the evidence). Before saving, scrub any
  echoed tokens or cookies (`Authorization`, `Set-Cookie`) from the headers file.
- If a token must be obtained first, fetch it into a shell variable within the same command and never
  print it.
- Inspect JSON with `node -e` or `jq` if present. Compare against the spec's schema for that operation.
- For GraphQL, POST `{"query": "...", "variables": {...}}`. A 200 with an `errors` array is a failure unless expected.

## B. Scripted execution (repo framework)

If `.claude/skills/repo-automation-conventions/SKILL.md` exists, **it takes precedence** (base API
test, request specs, auth helpers, config keys). Existing tests in automation repos are run via the
catalog (`make-suite.mjs` → build command → `parse-results.mjs`).

**Match the repo.** Read existing API tests in `automation.api.testDir` and reuse their client
setup, auth helper, base URL config, schema validation, and data builders. If `framework` is `none`,
propose the lightest option in the repo's language (Playwright `request` for a TS repo that already has
Playwright; RestAssured for Java; pytest+requests for Python; xUnit/NUnit + HttpClient for .NET) and
ask before adding it.

Naming contract: the test name **starts with the case id** (`TC-ORD-004 …`), one case per test, so
results map back. Update the case's `automation.status` / `automation.script` after automating.

Run with `automation.api.runCommand`, filtered by case ids, using a JSON or JUnit reporter.

## What to verify per operation

| Area | Checks |
|---|---|
| **Status** | Exact code per spec: 200/201/204, 400 (validation), 401 (no/invalid token), 403 (wrong role), 404, 409 (conflict), 422 |
| **Body/contract** | Validates against the spec schema; required fields present; types, formats (ISO dates, decimals as specified), enum values; no undocumented fields (flag as contract drift) |
| **Headers** | `Content-Type`; `Location` on 201; caching headers where relevant; security headers if in scope |
| **Errors** | Consistent error shape; helpful message; **no** stack traces, SQL, internal hostnames, or ids from other tenants |
| **Data effect** | GET after POST/PUT/PATCH returns what was written; DELETE then GET gives 404; list endpoints reflect changes |
| **Validation** | Boundaries and partitions on each field (`qa-test-design`); missing required; wrong type; extra fields; very large payload; unicode |
| **Auth & access** | No token → 401; expired token → 401; other role → 403; **another user's/tenant's resource id → 403/404 (IDOR)** |
| **Idempotency** | PUT/DELETE repeatable; POST with idempotency key doesn't duplicate; retry after timeout is safe |
| **Collections** | Pagination (first, last, beyond last, size limits), sorting, filtering, empty result |
| **Concurrency** | Two updates to the same resource; optimistic locking (ETag/If-Match, version) if supported |
| **Performance smell** | Note responses > 2s in the result `notes`. Don't load-test shared environments. |

## Contract testing from the spec

When `automation.apiSpecs` exists:
1. List operations touched by the change (or all of them for a contract regression)
2. For each operation: a positive case per documented success code, and a negative case per documented error code
3. When the spec file changed in the diff, run a breaking-change review (removed fields or endpoints, new
   required request fields, type changes, narrowed enums) and report it even when tests pass
