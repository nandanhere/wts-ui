use wts_checkout_api::order_payload;

#[test]
fn pay_303_exposes_an_integer_cent_contract() {
    assert_eq!(order_payload(4_250), "{\"total_cents\":4250}");
}
