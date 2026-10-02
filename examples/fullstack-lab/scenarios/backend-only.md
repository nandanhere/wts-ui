# API-202 — Include the loyalty threshold

Scope: `checkout-api`

The five-percent loyalty discount starts at exactly 10,000 cents, not one cent
after it. Do not change the UI repository or the injected `wts_api_202.rs`
acceptance test.

Verification: `cargo test`
