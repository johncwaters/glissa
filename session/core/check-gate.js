"use strict";

// Pure rules for the ADVISORY post-rebase check (2026-08 review, section 4).
//
// A merge queue runs the project's tests against the candidate as it would land, and merges only on
// green. Glissa's merge click is the operator's, so this is the advisory half of that: after an
// unattended auto-rebase rewrites a worktree onto a moved integration branch, run the project's check
// there and put the answer on the card BEFORE the operator clicks Merge. It never blocks the merge -
// it becomes a load-bearing gate only the day the merge click itself is automated.
//
// ON BY DEFAULT, and worth being plain about since a check command is arbitrary code running
// unattended in a worktree: any project whose worktree declares a package.json test script gets
// `npm test` after an auto-rebase without configuring anything. That is the useful default (the repos
// this runs in are the ones with tests), and three things bound it: the command comes from config.json
// only and never from the control WS (like `packs` and `remote`), a repo that declares no test script
// and configures no command runs NOTHING rather than failing every check, and `worktreePostRebaseCheck`
// switches the whole thing off. An earlier draft of this comment claimed it was hard to enable by
// accident, which was simply wrong about its own fallback.

const CHECK_STATUSES = Object.freeze(["pass", "fail", "timeout", "error"]);

function trimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Which command to run, and why. Per-project beats global; the npm fallback is last and applies only
 * when the worktree's package.json declares a test script, so a repo with no tests runs nothing rather
 * than failing every check on "missing script: test".
 *
 * @param {object} args
 * @param {string} [args.projectCheckCommand] the project record's own `checkCommand`
 * @param {string} [args.configCheckCommand] the top-level `checkCommand`
 * @param {object|null} [args.packageJson] the worktree's parsed package.json, or null
 * @returns {{ command: string|null, source: string }}
 */
function resolveCheckCommand({ projectCheckCommand, configCheckCommand, packageJson } = {}) {
  const perProject = trimmedString(projectCheckCommand);
  if (perProject) return { command: perProject, source: "project" };
  const global = trimmedString(configCheckCommand);
  if (global) return { command: global, source: "config" };
  const testScript = trimmedString(packageJson?.scripts?.test);
  if (testScript) return { command: "npm test", source: "package-json" };
  return { command: null, source: "none" };
}

/** Advisory only, so every outcome is reportable: there is no "did not run" that reads as a failure. */
function summarizeCheckResult({ exitCode, timedOut, error, output } = {}) {
  const tail = typeof output === "string" ? output : "";
  if (timedOut) return { status: "timeout", exitCode: null, tail };
  if (error) return { status: "error", exitCode: null, tail: tail || String(error) };
  if (exitCode === 0) return { status: "pass", exitCode: 0, tail };
  return { status: "fail", exitCode: Number.isInteger(exitCode) ? exitCode : null, tail };
}

/**
 * Whether an auto-rebase that just succeeded should be followed by a check. Kept beside the rebase
 * gate rather than inlined so the "advisory, and off unless a command actually resolves" rule has one
 * statement and one test.
 */
function decidePostRebaseCheck({ enabled, command, teardownPending, destroyed } = {}) {
  if (!enabled) return { run: false, reason: "disabled" };
  if (destroyed || teardownPending) return { run: false, reason: "teardown" };
  if (!trimmedString(command)) return { run: false, reason: "no-command" };
  return { run: true, reason: "rebased" };
}

module.exports = { CHECK_STATUSES, decidePostRebaseCheck, resolveCheckCommand, summarizeCheckResult };
