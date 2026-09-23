# Journeys: {{PACK_TITLE}}

Each journey has a **key** (used in test cases and module-map.json), the actors, the main flow, and
the alternate and exception flows. Keep each one short; tests carry the detail.

---

## `guest-checkout`: Guest buys products without an account

- **Actors**: anonymous shopper
- **Priority**: P1 (revenue)
- **Entry**: product page or cart
- **Main flow**:
  1. Add product(s) to the cart
  2. Checkout as guest, enter email and address
  3. Choose a delivery option
  4. Pay by card
  5. See the confirmation and receive an email
- **Alternates**: apply a promo code (step 1–4); change the address; PayPal instead of card
- **Exceptions**: card declined; out of stock at payment; payment provider timeout; session expiry
- **Systems touched**: web → orders-api → payments-api → notification-svc
- **Rules**: BR-CHK-01, BR-CHK-02, BR-PAY-01

---

## `{{journey-key}}`: {{Name}}

- **Actors**:
- **Priority**:
- **Entry**:
- **Main flow**:
- **Alternates**:
- **Exceptions**:
- **Systems touched**:
- **Rules**:
