export function projectOrder(event) {
  if (event.type !== "OrderAccepted") {
    throw new Error("unsupported event type");
  }
  return {
    id: event.orderId,
    totalCents: event.totalCents,
    status: "accepted",
    instance: event.instance,
  };
}
