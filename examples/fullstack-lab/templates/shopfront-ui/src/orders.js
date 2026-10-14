export function checkoutButtonLabel() {
  return "Submit order";
}

export function formatOrderTotal(order) {
  return `$${Number(order.total).toFixed(2)}`;
}
