---
name: qa-integration-testing
description: Core integration testing methodology covering contracts between UI and API, service to service, API to database, queues/events, and third parties; data flow and consistency; failure modes such as timeouts, retries, partial failure, and idempotency. Use when a change crosses a component boundary or when testing end-to-end data flow.
---

# Integration testing (L0 core)

Integration defects live **at the boundaries**: mismatched contracts, lost or duplicated data,
wrong assumptions about ordering or timing, and poor handling of a failing dependency.

## 1. Map the flow first

Before writing cases, draw the flow for the scenario in text:
```
UI (checkout page) → POST /orders (orders-api) → payments-api (sync) → orders DB
                                              ↘ OrderCreated event → notification-svc → email
```
Get this from the pack's `module-map.json` (`dependsOn`), the API spec, the code, or by watching
network traffic in an exploratory session. Mark each arrow as **sync/async**, and mark who owns
each component (our team or external).

## 2. Cover each boundary

| Boundary | Verify |
|---|---|
| **UI ↔ API** | UI sends what the API expects (fields, types, formats); UI handles every documented response, including 4xx/5xx and empty lists; UI-only validation is also enforced server-side |
| **API ↔ API** | Request/response match the contract (schema, required fields, enums, date/number formats); versioning; auth propagation; correlation ids |
| **API ↔ DB** | Written data matches the request (re-read it through the API, or query read-only if allowed); transactions: failure midway leaves no partial record |
| **Async (events/queues)** | Event published once, with correct payload; consumer effect happens (poll with timeout, don't sleep); duplicate delivery is handled idempotently; ordering assumptions |
| **Third party** | Correct request mapping; behaviour on their error, timeout, or slow response (usually via sandbox or stub) |

## 3. Failure-mode cases (the high-value ones)

- **Dependency down / 5xx / timeout**: user sees a sensible error, no data corruption, retry is safe
- **Slow dependency**: timeouts configured, no double-submit on UI retry
- **Idempotency**: repeating the same request (same idempotency key, double-click, network retry)
  doesn't create duplicates
- **Partial failure**: step 2 of 3 fails. Is it rolled back or compensated? Is the state visible to the user?
- **Data consistency**: the same entity shows the same values in every system that displays it
- **Concurrency**: two users or requests updating the same record (lost update, optimistic locking)

Only run failure-mode cases in environments that support them (stubs, sandboxes, feature flags).
Never cause outages in shared environments. Note environment limits in the plan.

## 4. Contract checks (API)

For each operation in scope, using `automation.apiSpecs` where available:
- Response body validates against the schema (types, required fields, enum values, formats)
- Every documented status code is reachable and has the documented error shape
- Undocumented fields or status codes are flagged as **contract drift**, not silently accepted
- Breaking-change check for a changed spec: removed or renamed fields, new required request fields,
  narrowed enums

## 5. Test data across systems

- Create data through the public entry point (UI/API), not by writing to the DB directly
- Use the run prefix `qa-auto-<runId>-` so data can be traced across systems and cleaned up
- Record ids created at each hop in the case result `notes` (order id, payment id, message id). This
  makes triage possible.

## 6. Cases

Write integration cases with `type: integration`. Put the flow in the first step or the
preconditions, and give each hop's check its own step with a concrete expected result.
