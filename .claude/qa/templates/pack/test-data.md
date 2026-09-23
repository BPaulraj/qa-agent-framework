# Test data: {{PACK_TITLE}}

**Never write secret values here.** Reference environment variable names only; each tester or CI
defines them locally or in pipeline secrets.

## Accounts

| Purpose | Username env var | Password/token env var | Envs | Notes |
|---|---|---|---|---|
| Standard customer | `QA_USER` | `QA_PASSWORD` | dev, qa | Has saved card and address |
| Member (free delivery) | `QA_MEMBER_USER` | `QA_MEMBER_PASSWORD` | qa | |
| Admin / back office | `QA_ADMIN_USER` | `QA_ADMIN_PASSWORD` | qa | Read-only in UAT |
| API client | n/a | `QA_API_TOKEN` | dev, qa | Scope: orders:rw |

## Reference data

| Item | Value | Notes |
|---|---|---|
| In-stock product | `QA-TSHIRT-M` | Stock topped up nightly |
| Out-of-stock product | `QA-HAT-OOS` | Always 0 stock |
| Sandbox card: success | `4111 1111 1111 1111` | any future expiry, CVV 123 |
| Sandbox card: decline | `4000 0000 0000 0002` | |
| Sandbox card: 3-D Secure | `4000 0000 0000 3220` | |
| Promo: valid | `QA10` | 10% off, no minimum |
| Promo: expired | `QAEXPIRED` | |

## Data rules

- Prefix everything you create with `qa-auto-<runId>-` (emails: `qa-auto-<runId>@example.com`)
- Clean up: {{e.g. cancel orders via POST /orders/{id}/cancel; nightly job purges qa-auto-* after 7 days}}
- Shared data that must **not** be modified: {{list}}
