export function greetingPayload(name, instanceId) {
  const normalizedName =
    typeof name === "string" && name.trim().length > 0 ? name.trim().slice(0, 80) : "developer";
  return {
    message: `Hello, ${normalizedName}!`,
    instance: instanceId,
  };
}
