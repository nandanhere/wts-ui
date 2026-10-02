export function publicOrder(projection) {
  return {
    id: projection.id,
    totalCents: projection.totalCents,
    status: projection.status,
    instance: projection.instance,
  };
}
