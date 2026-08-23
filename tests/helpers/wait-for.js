'use strict';

const assert = require('node:assert');

// Bounded wait on an observable fact instead of counting event-loop turns, whose number differs per
// platform (the POSIX prior-PTY reap takes more turns than the win32 taskkill the counts were tuned to).
async function waitFor(predicate, label = 'condition became true') {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), label);
}

module.exports = { waitFor };
