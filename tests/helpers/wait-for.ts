import assert from 'node:assert/strict';

async function waitFor(predicate: () => boolean, label = 'condition became true'): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), label);
}

export { waitFor };
