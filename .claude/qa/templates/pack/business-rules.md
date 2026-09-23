# Business rules: {{PACK_TITLE}}

These are the test oracle. Each rule has an id (`BR-<MOD>-NN`), a precise statement, examples at the
boundaries, and a source. Rules marked *(inferred, confirm)* were read from code and need domain sign-off.

| Id | Rule | Examples / boundaries | Source |
|---|---|---|---|
| BR-CHK-01 | Cart quantity per line is 1–10 | 0 → rejected "Minimum 1"; 10 → ok; 11 → rejected "Maximum 10" | Story 1180 AC2 |
| BR-CHK-02 | Free delivery when the cart subtotal after discounts is ≥ £50.00 | £49.99 → £3.95 delivery; £50.00 → free | Pricing policy v3 |
| BR-CHK-03 | Only one promo code per order; the last applied replaces the previous | apply A then B → only B active | `src/checkout/promo.ts:42` *(inferred, confirm)* |
| BR-PAY-01 | Orders over £1,000 require 3-D Secure | £1,000.00 → no challenge; £1,000.01 → challenge | Payments runbook |

## Decision tables (when rules combine)

### Delivery charge

| Subtotal ≥ £50 | Member | Express | Charge |
|---|---|---|---|
| Y | – | N | £0 |
| N | Y | N | £0 |
| N | N | N | £3.95 |
| – | – | Y | £7.95 |

## State models

### Order

```
DRAFT → PENDING_PAYMENT → CONFIRMED → SHIPPED → DELIVERED
             ↓                 ↓
          FAILED           CANCELLED   (cancel allowed only before SHIPPED)
```
