use wts_checkout_api::loyalty_discount_bps;

#[test]
fn api_202_applies_loyalty_discount_at_the_inclusive_threshold() {
    assert_eq!(loyalty_discount_bps(10_000), 500);
}
