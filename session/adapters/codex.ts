// THE Codex CLI adapter (M3 of docs/plan-agent-adapters.md). Same shape as the Claude Code one:
// data plus pure functions, with the one PATH lookup cached by the registry. Every clause below was
// settled by live probes against codex-cli 0.147.0 under node-pty on Linux; the two Windows-only
// clauses (the ConPTY first-title artifact, the cmd.exe shim spawn form) are inherited from the
// plan doc's 0.146.0 evidence and pinned by unit fixtures instead, since ConPTY cannot be reproduced
// off Windows.

import path from "node:path";

import { execSync } from "../../server/child-process-safe.js";
import { PACK_NAME_RE } from "../../server/core/pack-core.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import type { PathLookupExec, ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import { buildHookCommand } from "../core/hook-command-core.ts";
import { PACK_DIRECTIVE, renderPackPointerText } from "../core/pack-pointer-core.ts";
import type { PackDelivery } from "../core/pack-pointer-core.ts";
import type {
  AgentAdapterShape,
  AgentArgsOptions,
  AgentHookProfile,
  AgentSpawnCommandOptions,
  AgentTitleProfile,
} from "./index.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";

const ID = "codex";
const COMMAND_NAME = "codex";

// The relay ships beside this file and is run by codex as a command-type hook (session/hook-relay.ts).
const RELAY_PATH = path.resolve(import.meta.dirname, "..", "hook-relay.ts");
// Its rtk sibling, subscribed separately and only when rtk is on (session/rtk-relay.ts).
const RTK_RELAY_PATH = path.resolve(import.meta.dirname, "..", "rtk-relay.ts");
const RTK_HOOK_EVENT = "PreToolUse";
const RTK_TOOL_MATCHER = "Bash";

// The five events Glissa subscribes for detection.
const HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "PermissionRequest"];

// -- Environment ------------------------------------------------------------
// Codex exports no CLAUDECODE-style marker into its children, so there is nothing to scrub for
// nesting; the always-on Glissa-marker scrub in spawn-env.ts still applies. The blocking in-app
// update prompt is neutralized on argv (see UPDATE_CHECK_ARGS), not here: the npm wrapper sets
// CODEX_MANAGED_BY_NPM in the child env itself, so scrubbing it from ours would be a boundary in
// name only.
const envProfile: AgentEnvProfile = { scrub: [], set: {} };

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

function isSpinnerChar(char: string | null | undefined): boolean {
  if (!char) return false;
  const code = char.codePointAt(0) ?? 0;
  return code >= BRAILLE_MIN && code <= BRAILLE_MAX;
}

// A title carrying a path separator is a window title the shell or the OS wrote, never one codex
// wrote: it covers the ConPTY fake first title (`...codex.exe`, per the plan doc's Windows evidence)
// and the `cmd.exe /c codex` shim writing its own image path. Shape-based rather than
// platform-keyed, so the rule reads the same wherever it runs. Accepted cost: an operator who adds
// `git-branch` to [tui].terminal_title loses the title tier while on a branch with a slash in it,
// which costs nothing while hooks are wired.
function isPathLikeTitle(title: string): boolean {
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
function classifyTitle(title: string, { cwdBasename = null }: { cwdBasename?: string | null } = {}): string {
  if (isPathLikeTitle(title)) return "ignore";
  if (isSpinnerChar(String.fromCodePoint(title.codePointAt(0) ?? 0))) return "working";
  // Without a basename to compare against there is no way to tell codex's idle title from any other
  // program's, so neither shape resolves and the hook tier carries the session alone.
  if (!cwdBasename) return "ignore";
  if (ACTION_REQUIRED_RE.test(title)) return title.trimEnd().endsWith(cwdBasename) ? "awaiting-input" : "unknown";
  if (title.trim() === cwdBasename) return "ready";
  return "unknown";
}

const titleProfile: AgentTitleProfile = {
  classifyTitle,
  // Codex spins its title while it boots (MCP servers, plugins) and then settles on the idle one,
  // which the title tier alone reads as a work cycle that finished: a fresh card flashed COMPLETE,
  // with the "finished working" notification behind it, before the operator had typed anything.
  // Titles are therefore latched quiet until the first authoritative UserPromptSubmit, the same
  // latch /clear already uses (sessions.ts _titleQuiet).
  quietUntilFirstPrompt: true,
};

// -- Hook vocabulary --------------------------------------------------------
// Payload field vocabulary is CC-shaped snake_case (live-captured 0.147.0): session_id, turn_id,
// transcript_path, cwd, hook_event_name, model, permission_mode, plus per-event prompt /
// last_assistant_message / tool_name / tool_input / reason. Nothing needs aliasing.
function mapHookToSignal(event: string): string | null {
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
      // Main-agent turn end. Codex 0.149.0 fired this while a spawned child was still running, but
      // emitted no child hooks or background-work field, so the capability below keeps it ungated.
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
function mapHookConfidence(): string | null {
  return null;
}

function mapHookPromptKind(event: string): string | null {
  return String(event || "").toLowerCase() === "permissionrequest" ? "permission" : null;
}

function sessionIdOf(payload: HookPayload): unknown {
  return payload?.session_id;
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

function mayContributeHooks(configText: unknown): boolean {
  if (typeof configText !== "string") return false;
  return HOOKS_DECLARATION_RE.test(configText);
}

/*
 * One `-c hooks.<Event>=...` per subscribed event. This argv form is the only one `codex exec resume`
 * accepts, and it writes nothing to the operator's codex config. The trust bypass leads the group only
 * when the caller opted in AND nothing in the project tree declares hooks of its own; without it these
 * `-c` hooks are silently skipped unless the operator seeded a matching `trusted_hash` themselves,
 * which is a deliberate path and the reason they are still passed.
 */
function buildHookArgs({
  relayPath = RELAY_PATH,
  events = HOOK_EVENTS,
  bypassHookTrust = false,
  rtkRewrites = false,
  rtkRelayPath = RTK_RELAY_PATH,
}: {
  relayPath?: string;
  events?: string[];
  bypassHookTrust?: boolean;
  rtkRewrites?: boolean;
  rtkRelayPath?: string;
} = {}): string[] | null {
  const args = bypassHookTrust ? [TRUST_BYPASS_FLAG] : [];
  for (const event of events) {
    const command = buildHookCommand(relayPath, event);
    if (!command) return null;
    args.push("-c", `hooks.${event}=[{hooks=[{type='command',command='${command}'}]}]`);
  }
  if (!rtkRewrites) return args;
  const rtkCommand = buildHookCommand(rtkRelayPath, RTK_HOOK_EVENT);
  if (!rtkCommand) return args;
  args.push("-c", `hooks.${RTK_HOOK_EVENT}=[{matcher='${RTK_TOOL_MATCHER}',hooks=[{type='command',command='${rtkCommand}'}]}]`);
  return args;
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  // Command-type hooks on argv, pointed at session/hook-relay.ts; the URL and its bearer token ride
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
function resolveCommand(
  { platform, exec = execSync }: { platform?: NodeJS.Platform; exec?: PathLookupExec } = {},
): ResolvedCommand {
  return resolveAgentCommand({
    name: COMMAND_NAME,
    platform: platform || process.platform,
    exec,
  });
}

function buildSpawnCommand(
  { platform, resolved, settingsArgs = [], packArgs = [], agentArgs = [] }: AgentSpawnCommandOptions,
): { file: string; args: string[] } {
  return buildAgentSpawnCommand({
    name: COMMAND_NAME,
    platform,
    resolved,
    argGroups: [settingsArgs, packArgs, agentArgs],
  });
}

function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

function renderPackArgs(deliveries: readonly PackDelivery[], builtRoot: string): string[] | null {
  const pointerText = renderPackPointerText(deliveries, builtRoot, (name) => PACK_NAME_RE.test(name));
  if (pointerText === "") return [];
  if (pointerText == null) return null;
  return ["-c", `developer_instructions='''${pointerText}'''`];
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
}: AgentArgsOptions = {}): string[] {
  const args = [...UPDATE_CHECK_ARGS];
  if (resumeSessionId) args.push("resume", resumeSessionId);
  if (dangerouslySkipPermissions) args.push(...SKIP_PERMISSIONS_ARGS);
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (initialPrompt != null) args.push(initialPrompt);
  return args;
}

const codex = {
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
  buildHookArgs,
  buildHookCommand,
  mayContributeHooks,
  PROJECT_CONFIG_CANDIDATES,
  classifyTitle,
  mapHookToSignal,
  mapHookConfidence,
  mapHookPromptKind,
  sessionIdOf,
  HOOK_EVENTS,
  RELAY_PATH,
  RTK_RELAY_PATH,
  TRUST_BYPASS_FLAG,
  SKIP_PERMISSIONS_ARGS,
  UPDATE_CHECK_ARGS,
  PACK_DIRECTIVE,
  capabilities: {
    hooks: true,
    packReads: false,
    awaitingInput: true,
    // OFF: 0.149.0 spawned a real child but emitted only main Stop, with no background-work field.
    backgroundAgents: false,
    resume: true,
    packs: true,
    packNotice: true,
    // Status lines and anti-slop remain disabled because Codex support is unverified. rtk is ON:
    // live-probed on codex-cli 0.149.0, the PreToolUse group fires and its rewrite is honoured once
    // the verdict carries permissionDecision (session/core/rtk-hook-core.ts).
    statusLine: false,
    rtk: true,
    antiSlop: false,
    // Codex has PreCompact/PostCompact, but no false work cycle has been observed to justify
    // porting the quiet handling speculatively.
    compactQuiet: false,
    skipPermissionsFlag: true,
    headless: true,
  },
} satisfies AgentAdapterShape;

export default codex;
