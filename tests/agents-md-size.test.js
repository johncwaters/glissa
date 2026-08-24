'use strict';

// Loaded into every session via CLAUDE.md; cap keeps what-prose from creeping back in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAX_AGENTS_MD_BYTES = 30000;

test('root AGENTS.md stays under the instruction-tier byte budget', () => {
  const agentsMdPath = path.join(__dirname, '..', 'AGENTS.md');
  const sizeBytes = fs.statSync(agentsMdPath).size;
  assert.ok(
    sizeBytes <= MAX_AGENTS_MD_BYTES,
    `AGENTS.md is ${sizeBytes} bytes, over the ${MAX_AGENTS_MD_BYTES} byte budget. ` +
      'Cut what-prose (mechanism narration the code already shows) rather than raising the cap; ' +
      'rules and rationale belong as one invariant line plus a pointer.'
  );
});
