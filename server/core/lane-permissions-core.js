'use strict';

/*
 * The write boundary an ephemeral lane hands its headless session, as pure string building.
 *
 * Every clause here was settled by live probes against the real CLI (2.1.250) reading the machine
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

/*
 * The second half of a lane's posture: what the CLI is told to LOAD, which the settings file cannot
 * say. A lane inherits the operator's whole working environment by default, and on 2026-08-27 a visions
 * dispatch reading a 108-line prose buffer was carrying 66 MCP tools (Gmail, Notion, Calendar among
 * them), a 44-entry skill listing, and three of the operator's own SessionStart hooks instructing its
 * output style. None of that is a capability any lane asked for, and the MCP half is reach a lane
 * reading untrusted fenced text must not have at all.
 *
 * Probed against 2.1.250 in a throwaway cwd, each flag confirmed by counting what the transcript
 * actually loaded (skill_listing, deferred_tools_delta, hook_success) rather than by reading the help:
 *   - `--strict-mcp-config` with no `--mcp-config`: 66 MCP tools to 0. It also defeats
 *     `enableAllProjectMcpServers`, which detection/settings-injector.js plumbs into the same session's
 *     `--settings` file: a lane opting into that would get zero servers, decided here rather than there.
 *   - `--disable-slash-commands`: 44 skills to 0.
 *   - `--setting-sources project,local`: the operator's three SessionStart hooks to 0, and Glissa's OWN
 *     hooks, which ride `--settings`, still fired. That separation is the whole reason this is safe;
 *     a probe with a Stop hook in the lane settings file confirmed it rather than assuming it. The two
 *     sources it does keep are inert only because every lane on this seam cwds into an empty mkdtemp
 *     dir, so a lane run inside a real checkout would load that repo's settings and its hooks.
 * Together they took one lane spawn from 20191 to 3523 cache-create tokens with the write boundary and
 * the result file unchanged.
 *
 * The seam covers the THREE lanes that spawn in a throwaway cwd (visions, memory-distill,
 * pack-distill). pr-review and posthog are deliberately outside it: they cwd into a real repository
 * worktree and need Bash and gh, so they keep the operator's whole environment. The split is pinned by
 * tests/lane-permissions-core.test.js rather than left to be rediscovered.
 */
const LANE_ENVIRONMENT_ARGS = Object.freeze([
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--setting-sources', 'project,local',
]);

/**
 * One lane's permission posture: the settings the CLI is handed, plus the argv that decides what it
 * loads. No allow list in the settings at all: a bare `Write` allow is exactly what unbounds the
 * writes, and nothing narrower grants the tool.
 *
 * `allowTools` is a different mechanism from the deny list and not a substitute for it: `--tools` picks
 * the BUILT-IN set the session gets at all, so a lane naming it never has to enumerate the verbs it
 * does not want. Only a FOLLOWING OPTION-LIKE TOKEN ends that variadic flag, never the comma: probed on
 * 2.1.250, `--tools Read,Write "prompt"` ate the prompt and died with "Input must be provided", and the
 * same line with `--model opus` after the value ran. So it is emitted FIRST, ahead of the environment
 * flags, which is what makes every lane on this seam safe by construction rather than by argv luck.
 */
/** @param {{ denyTools?: readonly string[], allowTools?: readonly string[] }} [options] */
function buildLanePermissions({ denyTools = [], allowTools = [] } = {}) {
  const args = [];
  if (allowTools.length > 0) args.push('--tools', allowTools.join(','));
  args.push(...LANE_ENVIRONMENT_ARGS);
  return { permissions: { deny: [...denyTools], defaultMode: ACCEPT_EDITS_MODE }, args };
}

module.exports = { ACCEPT_EDITS_MODE, LANE_ENVIRONMENT_ARGS, buildLanePermissions };
