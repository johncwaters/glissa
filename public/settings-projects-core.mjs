export function unionProjectSelection({ checked = [], stored = [], rendered = [] } = {}) {
  const renderedIds = new Set(rendered);
  const selection = [...checked];
  for (const id of stored) {
    if (typeof id !== 'string' || !id.trim()) continue;
    if (renderedIds.has(id) || selection.includes(id)) continue;
    selection.push(id);
  }
  return selection;
}
