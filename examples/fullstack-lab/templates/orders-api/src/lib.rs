pub fn loyalty_discount_bps(subtotal_cents: u64) -> u16 {
    if subtotal_cents > 10_000 { 500 } else { 0 }
}

pub fn order_payload(total_cents: u64) -> String {
    format!("{{\"total\":{:.2}}}", total_cents as f64 / 100.0)
}

#[cfg(test)]
mod tests {
    use super::{loyalty_discount_bps, order_payload};

    #[test]
    fn small_orders_do_not_receive_a_loyalty_discount() {
        assert_eq!(loyalty_discount_bps(4_250), 0);
    }

    #[test]
    fn order_payload_is_json_shaped() {
        let payload = order_payload(4_250);
        assert!(payload.starts_with('{'));
        assert!(payload.ends_with('}'));
    }
}
