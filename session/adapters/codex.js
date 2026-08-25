"use strict";

// THE Codex CLI adapter (M3 of docs/plan-agent-adapters.md). Same shape as the Claude Code one:
// data plus pure functions, with the one PATH lookup cached by the registry. Every clause below was
// settled by live probes against codex-cli 0.147.0 under node-pty on Linux; the two Windows-only
// clauses (the ConPTY first-title artifact, the cmd.exe shim spawn form) are inherited from the
// plan doc's 0.146.0 evidence and pinned by unit fixtures instead, since ConPTY cannot be reproduced
// off Windows.

const path = require("node:path");

const { resolveAgentCommand, buildAgentSpawnCommand } = require("../core/spawn-command");
const { buildAgentEnv } = require("../core/spawn-env");

const ID = "codex";
const COMMAND_NAME = "codex";

// The relay ships beside this file and is run by codex as a command-type hook (session/hook-relay.js).
const RELAY_PATH = path.resolve(__dirname, "..", "hook-relay.js");

// The five events Glissa subscribes. PreToolUse/PostToolUse are deliberately absent: a per-tool-call
// callback is the pack-read-telemetry cost without pack-read telemetry's justification, and nothing
// in the codex signal map needs one.
const HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "PermissionRequest"];

// -- Environment ------------------------------------------------------------
// Codex exports no CLAUDECODE-style marker into its children, so there is nothing to scrub for
// nesting; the always-on Glissa-marker scrub in spawn-env.js still applies. The blocking in-app
// update prompt is neutralized on argv (see UPDATE_CHECK_ARGS), not here: the npm wrapper sets
// CODEX_MANAGED_BY_NPM in the child env itself, so scrubbing it from ours would be a boundary in
// name only.
const envProfile = { scrub: [], set: {} };

// -- Title profile ----------------------------------------------------------
// Live-captured title grammar (0.147.0, interactive TUI):
//   working        "<braille> <cwd basename>"          e.g. "⢹ codexprobe"
//   idle           "<cwd basename>"                    e.g. "codexprobe"
//   awaiting input "[ ! ] Action Required | <basename>" blinking against "[ . ] ..." at 1 Hz
// Unlike Claude Code, codex leads its idle and awaiting-input titles with plain ASCII, so the
// leading-glyph classification the Claude profile uses cannot work here and the whole title is
// classified instead.
const BRAILLE_MIN = 0x2800;
const BRAILLE_MAX = 0x28ff;

// Both blink frames of the same state; the source dedups them into one signal. The trailing
// `| <basename>` is part of the match on purpose: see classifyTitle.
const ACTION_REQUIRED_RE = /^\[\s*[.!]\s*\]\s*Action Required\b/;

function isSpinnerChar(char) {
  if (!char) return false;
  const code = char.codePointAt(0);
  return code >= BRAILLE_MIN && code <= BRAILLE_MAX;
}

// A title carrying a path separator is a window title the shell or the OS wrote, never one codex
// wrote: it covers the ConPTY fake first title (`...codex.exe`, per the plan doc's Windows evidence)
// and the `cmd.exe /c codex` shim writing its own image path. Shape-based rather than
// platform-keyed, so the rule reads the same wherever it runs. Accepted cost: an operator who adds
// `git-branch` to [tui].terminal_title loses the title tier while on a branch with a slash in it,
// which costs nothing while hooks are wired.
function isPathLikeTitle(title) {
  return title.includes("/") || title.includes("\\");
}

/*
 * A title is only ever read as codex's own when it MATCHES codex's grammar for this session, never as
 * a catch-all. A supervised agent runs other programs, and plenty of them write an OSC-0 title; an
 * earlier revision defaulted an unrecognized title to `ready`, which let any such program complete the
 * card (or, via a forged Action Required line, park it in WAITING and with it the auto-rebase). So the
 * idle and awaiting-input shapes both have to carry the session's own cwd basename, and a title that
 * matches nothing is reported as `unknown`: telemetry, never a transition.
 */
function classifyTitle(title, { cwdBasename = null } = {}) {
  if (isPathLikeTitle(title)) return "ignore";
  if (isSpinnerChar(String.fromCodePoint(title.codePointAt(0)))) return "working";
  // Without a basename to compare against there is no way to tell codex's idle title from any other
  // program's, so neither shape resolves and the hook tier carries the session alone.
  if (!cwdBasename) return "ignore";
  if (ACTION_REQUIRED_RE.test(title)) return title.trimEnd().endsWith(cwdBasename) ? "awaiting-input" : "unknown";
  if (title.trim() === cwdBasename) return "ready";
  return "unknown";
}

const titleProfile = {
  classifyTitle,
  // Codex spins its title while it boots (MCP servers, plugins) and then settles on the idle one,
  // which the title tier alone reads as a work cycle that finished: a fresh card flashed COMPLETE,
  // with the "finished working" notification behind it, before the operator had typed anything.
  // Titles are therefore latched quiet until the first authoritative UserPromptSubmit, the same
  // latch /clear already uses (sessions.js _titleQuiet).
  quietUntilFirstPrompt: true,
};

// -- Hook vocabulary --------------------------------------------------------
// Payload field vocabulary is CC-shaped snake_case (live-captured 0.147.0): session_id, turn_id,
// transcript_path, cwd, hook_event_name, model, permission_mode, plus per-event prompt /
// last_assistant_message / tool_name / tool_input / reason. Nothing needs aliasing.
function mapHookToSignal(event) {
  const e = String(event || "").toLowerCase();
  switch (e) {
    case "sessionstart":
      // Lifecycle telemetry only. Codex fires this LAZILY, at the first turn rather than at process
      // start (live-probed: a TUI sitting at the composer for 15s fired nothing), so nothing may be
      // keyed off its arrival - including the id capture, which reads whichever hook lands first.
      return "session-start";
    case "sessionend":
      return "session-end";
    case "userpromptsubmit":
      return "resume";
    case "stop":
      // Main-agent turn end. Codex declares no background-work field, and its SubagentStart/Stop
      // firing conditions are unverified, so this `ready` reaches the completion gate ungated -
      // which is exactly why the backgroundAgents capability is off (see capabilities below).
      return "ready";
    case "permissionrequest":
      // Codex's approval prompt, and the ONLY authoritative awaiting-input signal it has: there is
      // no Notification event at all, so a prose question that ends a turn is indistinguishable
      // from a completed one. Stated in the detection tiers table of the plan doc, not papered over.
      return "awaiting-input";
    default:
      return null;
  }
}

// Codex has no idle-nudge equivalent to demote, so every mapped signal keeps the source default.
function mapHookConfidence() {
  return null;
}

function mapHookPromptKind(event) {
  return String(event || "").toLowerCase() === "permissionrequest" ? "permission" : null;
}

/*
 * Hook trust is persisted as `hooks.state."<source>:<event>:<group>:<index>".trusted_hash` and is read
 * from the config FILE only: seeding it through `-c` is ignored (live-probed both ways, 0.147.0), and
 * the only file that would work is the operator's own ~/.codex/config.toml, which Glissa does not
 * write. That leaves the bypass, and the bypass is NOT a way to trust Glissa's own hooks: it turns
 * review off for EVERY enabled hook this invocation loads. Codex loads `.codex/config.toml` from the
 * project tree of a trusted directory, that file may declare hooks, and Glissa's `-c` hooks MERGE with
 * those rather than replacing them, so the reachable set is the operator's config PLUS whatever the
 * repository ships PLUS whatever the supervised agent itself writes into its own workspace (which the
 * NEXT spawn would then execute, outside any approval path). It is therefore OFF by default and opted
 * in per project (`projects[].codexBypassHookTrust`), and even when opted in the session refuses it
 * once a project-tree `.codex/config.toml` declares hooks. Without it, codex silently skips Glissa's
 * hooks and the card degrades to the title tier, which is exactly what an untrusted install does today.
 */
const TRUST_BYPASS_FLAG = "--dangerously-bypass-hook-trust";

/*
 * Every project-scoped file in the cwd's ancestry that could hand codex a hook. BOTH are real
 * sources: codex loads `.codex/config.toml` and `.codex/hooks.json`, and warns when it finds both
 * ("loading hooks from both ..."). `hooks.json` needs no parse at all - a file at that path exists to
 * declare hooks, so its PRESENCE is the answer.
 */
const PROJECT_CONFIG_CANDIDATES = Object.freeze([
  Object.freeze({ relPath: ".codex/config.toml", presenceIsHit: false }),
  Object.freeze({ relPath: ".codex/hooks.json", presenceIsHit: true }),
]);

/*
 * Could this project-scoped codex config contribute a hook that the trust bypass would then run
 * unreviewed? Conservative and shape-based, over three arms: a `hooks` TABLE HEADER in any spelling
 * TOML allows, a `hooks... =` assignment, and any `extends`, which points at a file this predicate
 * cannot see. The header arm accepts one or two brackets and an optional quote because the canonical
 * codex hook group is an ARRAY OF TABLES (`[[hooks.SessionStart]]`, `[[hooks.SessionStart.hooks]]`) and
 * a quoted key (`["hooks".SessionStart]`) is the same table by another name: a single-bracket-only
 * match read as thorough is exactly the hole this guard exists to close. A false yes costs the title
 * tier for that session; a false no runs somebody else's code as the operator, so the two are not
 * weighed the same.
 */
const HOOKS_DECLARATION_RE = /^[^\S\r\n]*(?:\[{1,2}[^\S\r\n]*["']?hooks\b|hooks[.\w"'-]*[^\S\r\n]*=|extends[^\S\r\n]*=)/m;

function mayContributeHooks(configText) {
  if (typeof configText !== "string") return false;
  return HOOKS_DECLARATION_RE.test(configText);
}

/*
 * A hook command is one TOML LITERAL string (single quotes, no escapes) inside one `-c` value, which
 * keeps double quotes off the argv: on Windows a shim install spawns through `cmd.exe /c codex`, and
 * every double quote in a token is one more thing cmd's re-parse can mangle.
 *
 * Codex runs that command through a SHELL, not an argv split with quoting (live-verified: a command
 * of `touch A; touch B` ran both), so the path is held to a conservative charset rather than merely
 * escaped. `$(...)` and backticks interpolate even inside double quotes, and `;`, `&`, `|`, `>` need
 * no quotes at all, so anything outside the allow-list is refused and the caller degrades that
 * session to the title tier instead of emitting a command it cannot vouch for. The path is Glissa's
 * own `__dirname` in practice, which is why this is a guard rather than a live exposure.
 */
const SAFE_PATH_RE = /^[A-Za-z0-9_.:/\\ -]+$/;
const SAFE_PACK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PACK_DIRECTIVE = "Glissa context packs are available at these index files. Read each relevant CLAUDE.md before working:";

function buildHookCommand(relayPath, event) {
  const raw = String(relayPath);
  if (!SAFE_PATH_RE.test(raw)) return null;
  const forwardSlashed = raw.replace(/\\/g, "/");
  const quoted = /\s/.test(forwardSlashed) ? `"${forwardSlashed}"` : forwardSlashed;
  return `node ${quoted} ${event}`;
}

/*
 * One `-c hooks.<Event>=...` per subscribed event. This argv form is the only one `codex exec resume`
 * accepts, and it writes nothing to the operator's codex config. The trust bypass leads the group only
 * when the caller opted in AND nothing in the project tree declares hooks of its own; without it these
 * `-c` hooks are silently skipped unless the operator seeded a matching `trusted_hash` themselves,
 * which is a deliberate path and the reason they are still passed.
 */
function buildHookArgs({ relayPath = RELAY_PATH, events = HOOK_EVENTS, bypassHookTrust = false } = {}) {
  const args = bypassHookTrust ? [TRUST_BYPASS_FLAG] : [];
  for (const event of events) {
    const command = buildHookCommand(relayPath, event);
    if (!command) return null;
    args.push("-c", `hooks.${event}=[{hooks=[{type='command',command='${command}'}]}]`);
  }
  return args;
}

const hooks = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  // Command-type hooks on argv, pointed at session/hook-relay.js; the URL and its bearer token ride
  // the spawn env, never the command line.
  injection: {
    kind: "argv-config",
    relayPath: RELAY_PATH,
    events: HOOK_EVENTS,
    buildHookArgs,
    // The session walks the cwd's ancestry for these files and refuses the trust bypass when one
    // could contribute a hook, so an agent-written or repo-shipped hook is never run unreviewed.
    projectConfigCandidates: PROJECT_CONFIG_CANDIDATES,
    mayContributeHooks,
  },
};

// -- Spawn ------------------------------------------------------------------
function resolveCommand({ platform, exec } = {}) {
  return resolveAgentCommand({
    name: COMMAND_NAME,
    ...(platform ? { platform } : {}),
    ...(exec ? { exec } : {}),
  });
}

function buildSpawnCommand({ platform, resolved, settingsArgs = [], packArgs = [], agentArgs = [] }) {
  return buildAgentSpawnCommand({
    name: COMMAND_NAME,
    platform,
    resolved,
    argGroups: [settingsArgs, packArgs, agentArgs],
  });
}

function buildEnv(baseEnv, extraEnv, options) {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

function renderPackArgs(deliveries) {
  if (!Array.isArray(deliveries) || deliveries.length === 0) return [];
  const lines = [];
  for (const delivery of deliveries) {
    if (!delivery || !SAFE_PACK_NAME_RE.test(delivery.name)) return null;
    const packDir = String(delivery.dir || "");
    const indexPath = path.join(packDir, "CLAUDE.md");
    const isAbsolute = path.isAbsolute(packDir) || path.win32.isAbsolute(packDir);
    if (!isAbsolute || !SAFE_PATH_RE.test(indexPath)) return null;
    lines.push(`${delivery.name}: ${indexPath}`);
  }
  const instructions = [PACK_DIRECTIVE, ...lines].join("; ");
  return ["-c", `developer_instructions='''${instructions}'''`];
}

/*
 * A supervised session must never self-update. With a managed install (the npm wrapper exports
 * CODEX_MANAGED_BY_NPM into the child) codex opens a BLOCKING startup prompt whose pre-selected item
 * is "Update now (runs `npm install -g @openai/codex`)", so a spawn that answered Enter would replace
 * the binary under the operator. `--disable in_app_updates` does not suppress it (re-probed on
 * 0.147.0, same as the doc's 0.146.0 finding); this config key does, with no file written and no
 * keystroke guessed at. Glissa's own update-check lane is where an available update belongs.
 */
const UPDATE_CHECK_ARGS = ["-c", "check_for_update_on_startup=false"];

/*
 * The codex equivalent of --dangerously-skip-permissions, and deliberately NOT
 * `--dangerously-bypass-approvals-and-sandbox`. The operator ticks one checkbox that means "stop
 * asking me", and on Claude Code there is no sandbox for it to cost them; codex HAS one, and that flag
 * removes it as well as the prompts, so the same tick would have bought an unrestricted, network-capable,
 * prompt-injectable session. `-a never` stops the asking and `-s workspace-write` keeps the sandbox,
 * which is the honest translation of what the checkbox says. It silences PermissionRequest either way,
 * exactly as its Claude counterpart silences the permission prompt.
 */
const SKIP_PERMISSIONS_ARGS = ["-a", "never", "-s", "workspace-write"];

// `codex resume <id>` continues the SAME conversation under the SAME id (live-verified: ids are
// stable across resume and the transcript file is reused), so the subcommand leads the argv and the
// prompt stays the final positional. Global options are accepted on either side of a subcommand
// (live-verified), which is what lets the hook group ride in front of it unchanged.
function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  initialPrompt = null,
} = {}) {
  const args = [...UPDATE_CHECK_ARGS];
  if (resumeSessionId) args.push("resume", resumeSessionId);
  if (dangerouslySkipPermissions) args.push(...SKIP_PERMISSIONS_ARGS);
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (initialPrompt != null) args.push(initialPrompt);
  return args;
}

module.exports = {
  id: ID,
  label: "Codex CLI",
  // The usage lane's vendor namespace (usage-scanner tags Codex transcript entries `codex`); the lane
  // ledger's composite key and the per-card chip join both key on it, never on the adapter id.
  usageVendor: "codex",
  commandName: COMMAND_NAME,
  envProfile,
  titleProfile,
  hooks,
  resolveCommand,
  buildSpawnCommand,
  buildEnv,
  buildArgs,
  renderPackArgs,
  packCarrier: "developer_instructions index pointers",
  packNoticeCaveat: "staleness notices require trusted UserPromptSubmit hooks or the hook-trust bypass",
  packReadTelemetry: false,
  buildHookArgs,
  buildHookCommand,
  mayContributeHooks,
  PROJECT_CONFIG_CANDIDATES,
  classifyTitle,
  mapHookToSignal,
  mapHookConfidence,
  mapHookPromptKind,
  HOOK_EVENTS,
  RELAY_PATH,
  TRUST_BYPASS_FLAG,
  SKIP_PERMISSIONS_ARGS,
  UPDATE_CHECK_ARGS,
  PACK_DIRECTIVE,
  capabilities: {
    hooks: true,
    awaitingInput: true,
    // OFF until a multi-agent codex turn is observed live. SubagentStart/SubagentStop are in the
    // event table, but nothing has verified when they fire, and codex declares no background_tasks
    // equivalent; a gate fed by unverified signals would hold cards WORKING forever, which is worse
    // than completing one early.
    backgroundAgents: false,
    resume: true,
    packs: true,
    packNotice: true,
    statusLine: false,
    rtk: false,
    antiSlop: false,
    // Codex has PreCompact/PostCompact, but no false work cycle has been observed to justify
    // porting the quiet handling speculatively.
    compactQuiet: false,
    skipPermissionsFlag: true,
    headless: true,
  },
};
