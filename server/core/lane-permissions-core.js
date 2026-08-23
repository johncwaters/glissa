'use strict';

/*
 * The write boundary an ephemeral lane hands its headless session, as pure string building.
 *
 * Every clause here was settled by live probes against the real CLI (2.1.241) reading the machine
 * readable `tool_result` and `permission_denials` of a `--output-format stream-json` run, because four
 * plausible spellings of "may write only here" fail SILENTLY:
 *   - `Write(<glob>)` in an allow list is refused by name: "not matched by file permission checks -
 *     only Edit(path) rules are."
 *   - `Edit(<dir>/**)` in an allow list does NOT grant the Write tool either, the CLI hint above
 *     notwithstanding: probed under defaultMode `default`, a Write INSIDE that dir was still refused
 *     with "Claude requested permissions to write to <path>, but you haven't granted it yet."
 *   - A path deny (`Edit(<dir>/**)` or `Write(<dir>/**)`) does NOT refuse a Write tool call when a bare
 *     `Write` allow is present: probed both spellings, the file was created both times. A path deny is
 *     therefore not a boundary and is not used as one here.
 *   - A bare `Read` deny DOES refuse the Write tool ("covered by Read deny rule ... Write tool
 *     refused"), so no lane may deny bare Read, Write, Glob or Grep and still write a result file. A
 *     bare `Edit` deny does not block Write, which is why the deny list below works as written.
 *
 * What DOES bound the writes is `defaultMode: acceptEdits` with NO bare `Write` allow: edits are
 * auto-accepted inside the session's cwd and refused anywhere else ("you haven't granted it yet",
 * probed with and without a path deny, which changed nothing). The cwd each lane hands the session is a
 * fresh temp dir holding only its result file, so that mode plus that cwd IS the boundary. The mode is
 * set in the lane's managed settings file, which overrides the operator's own `defaultMode` (an
 * operator running `auto` otherwise has an LLM classifier deciding these writes rather than a rule).
 * Claude Code separately refuses edits to its own home as "a sensitive file", which covers the
 * settings.json hook-registration path independently of anything here.
 */

const ACCEPT_EDITS_MODE = 'acceptEdits';

/**
 * One lane's permission posture. No allow list at all: a bare `Write` allow is exactly what unbounds
 * the writes, and nothing narrower grants the tool.
 */
function buildLanePermissions({ denyTools = [] } = {}) {
  return { permissions: { deny: [...denyTools], defaultMode: ACCEPT_EDITS_MODE } };
}

module.exports = { ACCEPT_EDITS_MODE, buildLanePermissions };
