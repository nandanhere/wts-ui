# PAY-303 — Use integer cents across checkout

Scope: `storefront-ui`, `checkout-api`

Replace the floating-point `total` response field with the integer
`total_cents` field and update the UI formatter to consume that contract. Do
not change either injected `wts_pay_303` acceptance test.

Verification: `npm test` in `storefront-ui`, then `cargo test` in
`checkout-api`.
