export function lanePlaceholder(status, { label, tab }) {
  if (!status) return `Waiting for ${label} status from the server.`;
  const reason = typeof status.reason === 'string' ? status.reason.trim() : '';
  if (status.configured === false && reason) return `${label} is misconfigured: ${reason}. Open Settings and its ${tab} tab.`;
  if (status.configured === false) return `${label} is off. Open Settings and its ${tab} tab to switch it on.`;
  return `${label} is on. Waiting for the first poll.`;
}
