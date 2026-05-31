'use strict';

// Pure deny-matcher for team-stage tool calls.
//
// A denyPattern is a "Tool(glob)" string, e.g. "Bash(rm *)" or "Write(**/.env)". Matching is
// case-insensitive and whitespace-tolerant. `*` and `**` both collapse to `.*` — coarse on
// purpose: a safety denylist should err toward matching.
//
// This is a FAIL-OPEN denylist (see .omc/plans/marketing-team-pipeline.md, driver D3): it cannot
// enumerate every dangerous path (MCP tools, Edit, shell evasion via cd/subshell). The PRIMARY
// guardrail is running stages against a clean, committed target repo; this matcher is
// defense-in-depth on top.

const PATTERN_RE = /^([A-Za-z]\w*)\((.*)\)$/;

// Convert a shell/path glob into an anchored, case-insensitive RegExp. A leading "*/" (from a
// "**/x" path pattern) is made optional so "**/.env" matches both "proj/.env" and a bare ".env".
function globToRegExp(glob) {
  let re = String(glob).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&'); // escape regex specials, keep *
  re = re.replace(/\*+/g, '.*'); // ** or * -> .*
  re = re.replace(/^\.\*\//, '(?:.*/)?'); // optional leading directory for "**/x" patterns
  return new RegExp(`^${re}$`, 'i');
}

// Parse a "Tool(glob)" pattern into { tool, glob }, or null if malformed.
function parsePattern(pattern) {
  const m = PATTERN_RE.exec(String(pattern).trim());
  if (!m) return null;
  return { tool: m[1], glob: m[2] };
}

// toolCall: { tool: string, input: string }. Returns true if any denyPattern matches.
function isDenied(toolCall, denyPatterns) {
  if (!toolCall || !Array.isArray(denyPatterns)) return false;
  const tool = String(toolCall.tool || '').toLowerCase();
  const input = String(toolCall.input == null ? '' : toolCall.input)
    .trim()
    .replace(/\\/g, '/'); // normalize Windows path separators for path-glob matching
  return denyPatterns.some((pattern) => {
    const parsed = parsePattern(pattern);
    if (!parsed) return false;
    if (parsed.tool.toLowerCase() !== tool) return false;
    return globToRegExp(parsed.glob).test(input);
  });
}

module.exports = { isDenied, globToRegExp, parsePattern };
