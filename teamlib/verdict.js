'use strict';

const { escapeRegExp } = require('./markdown');

const DEFAULT_MARKER = 'VERDICT:';

// Match `<marker>\s*([A-Za-z]+)` case-insensitively and return the captured token uppercased, or null.
// Shared regex core for the orchestrator's strict parseVerdict and team-output's loose run-summary scan.
// [A-Za-z] is equivalent to the orchestrator's original [A-Z] under the i flag; broadened for clarity only.
function extractVerdictToken(text, marker = DEFAULT_MARKER) {
  if (!text) return null;
  const re = new RegExp(`${escapeRegExp(marker)}\\s*([A-Za-z]+)`, 'i');
  const m = re.exec(text);
  return m ? m[1].toUpperCase() : null;
}

// Strict verdict parse for a stage's VERDICT line: gated by verdictSpec's marker AND its allowed values,
// so a stray/misspelled token never passes as a real verdict. Returns the matched value or null.
function parseVerdict(text, verdictSpec) {
  if (!text || !verdictSpec) return null;
  const marker = verdictSpec.marker || DEFAULT_MARKER;
  const values = verdictSpec.values || ['SHIP', 'FIX', 'BLOCK'];
  const found = extractVerdictToken(text, marker);
  return found && values.includes(found) ? found : null;
}

module.exports = { extractVerdictToken, parseVerdict };
