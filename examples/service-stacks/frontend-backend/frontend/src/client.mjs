export function greetingApiPath(name) {
  const parameters = new URLSearchParams({ name });
  return `/api/greeting?${parameters}`;
}

export function renderGreeting(payload) {
  return `<p data-instance="${escapeHtml(payload.instance)}">${escapeHtml(payload.message)}</p>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
