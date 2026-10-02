export function createOrderEvent(value, instanceId) {
  if (
    value === null ||
    typeof value !== "object" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.id) ||
    !Number.isSafeInteger(value.totalCents) ||
    value.totalCents < 0 ||
    value.totalCents > 100_000_000
  ) {
    throw new Error("order must contain a safe id and bounded totalCents");
  }
  return {
    type: "OrderAccepted",
    orderId: value.id,
    totalCents: value.totalCents,
    instance: instanceId,
  };
}
