export function normalizeJob(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.id) ||
    !Number.isSafeInteger(value.input) ||
    value.input < -1_000_000 ||
    value.input > 1_000_000
  ) {
    throw new Error("job must contain a safe id and bounded integer input");
  }
  return {
    id: value.id,
    input: value.input,
    operation: "double",
  };
}
