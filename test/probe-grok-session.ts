// Live verification of the Grok adapter, run by hand against a REAL grok binary:
// node test/probe-grok-session.ts [--keep]

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { runAgentSetupCli } from "../server/agent-setup-cli.ts";
import { createBackend } from "../server/backend.ts";
import grok from "../session/adapters/grok.ts";
import type { Session } from "../session/sessions.ts";
import type { HookPayload } from "../shared/contracts/index.ts";

// _packsBuiltRoot and _hookToken are no longer Session fields; the probe still names them, so the
// shape it writes and reads is declared here rather than pretended into the class.
interface ProbeSession extends Session {
  _packsBuiltRoot?: string;
  _hookToken?: string;
}

interface SpawnCall {
  file: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string | undefined>;
}

interface StateChange {
  from: string;
  to: string;
  event: string;
}

interface HookRecord {
  event: string | undefined;
  payload: HookPayload;
}

const SESSION_ID = "grok-probe-session";
const PROMPT = "Run the shell command: touch ./grok-probe-approval.txt";
const PACK_NAME = "live-probe-pack";
const SENTINEL_WORD = "amberlattice";
const PACK_PROMPT = "what sentinel word does the glissa context pack data file contain, answer with the word only";
const STEP_TIMEOUT_MS = 90000;
const USAGE = "Usage: node test/probe-grok-session.ts [--keep]\n--keep retains a sanitized copy of the full authenticated PTY transcript.";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
    return;
  }
  console.error(`  FAIL  ${label}`);
  failed += 1;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function waitForState(session: Session, states: string[], label: string): Promise<string> {
  const wantedStates = new Set(states);
  if (wantedStates.has(session.state)) return Promise.resolve(session.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off("state-change", onStateChange);
      reject(new Error(`timed out waiting for ${label}, still ${session.state}`));
    }, STEP_TIMEOUT_MS);
    function onStateChange({ to }: { to: string }): void {
      if (!wantedStates.has(to)) return;
      clearTimeout(timer);
      session.off("state-change", onStateChange);
      resolve(to);
    }
    session.on("state-change", onStateChange);
  });
}

function linkFile(source: string, target: string): boolean {
  if (!fs.existsSync(source)) return false;
  fs.symlinkSync(source, target);
  return true;
}

function makeProbeGrokHome(tempDirectory: string, nativeBinaryPath: string): string {
  const grokHome = path.join(tempDirectory, "grok-home");
  const binDirectory = path.join(grokHome, "bin");
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.symlinkSync(nativeBinaryPath, path.join(binDirectory, process.platform === "win32" ? "grok.exe" : "grok"));
  const authLinked = linkFile(path.join(os.homedir(), ".grok", "auth.json"), path.join(grokHome, "auth.json"));
  if (!authLinked) throw new Error("Grok credentials are unavailable. Sign in outside this probe, then run it again.");
  return grokHome;
}

function writeProbeConfig(configPath: string, projectDirectory: string): void {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{
      id: SESSION_ID,
      name: "grok probe",
      path: projectDirectory,
      agent: "grok",
      dangerouslySkipPermissions: false,
      packs: [PACK_NAME],
    }],
    teams: [],
    repoRoots: [],
    packsAutoRebuild: false,
    autoResume: false,
    worktreeAutoRebase: false,
    capture: { enabled: true },
  }, null, 2), "utf8");
}

function makeProbePack(tempDirectory: string): string {
  const builtRoot = path.join(tempDirectory, "packs", "built");
  const currentDirectory = path.join(builtRoot, PACK_NAME, "current");
  const dataDirectory = path.join(currentDirectory, "data");
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(currentDirectory, "CLAUDE.md"),
    "# Glissa live probe pack\n\nFor sentinel questions, read `data/sentinel.txt`.\n",
    "utf8",
  );
  fs.writeFileSync(path.join(dataDirectory, "sentinel.txt"), `${SENTINEL_WORD}\n`, "utf8");
  fs.writeFileSync(
    path.join(currentDirectory, "manifest.json"),
    JSON.stringify({ name: PACK_NAME, version: "live-probe-v1", tokenEstimate: 20 }, null, 2),
    "utf8",
  );
  return builtRoot;
}

function writeClaudeHookProbe(tempDirectory: string): { childHome: string; markerPath: string } {
  const childHome = path.join(tempDirectory, "child-home");
  const claudeDirectory = path.join(childHome, ".claude");
  const hookScriptPath = path.join(tempDirectory, "claude-hook-probe.js");
  const markerPath = path.join(tempDirectory, "claude-hook-fired.txt");
  fs.mkdirSync(claudeDirectory, { recursive: true });
  fs.writeFileSync(
    hookScriptPath,
    `"use strict"; require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "fired\\n", "utf8");\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(claudeDirectory, "settings.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${hookScriptPath}` }] }],
      },
    }, null, 2),
    "utf8",
  );
  return { childHome, markerPath };
}

function isUuidV7(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function isWorkingTitle(title: unknown): boolean {
  const firstCharacter = String(title || "").charAt(0);
  const codePoint = firstCharacter.codePointAt(0);
  if (codePoint === undefined) return false;
  return codePoint >= 0x2800 && codePoint <= 0x28ff;
}

function answerFrom(payload: HookPayload | undefined): string | null {
  const answer = payload?.lastAssistantMessage;
  return typeof answer === "string" ? answer.trim() : null;
}

function captureTitles(session: Session, titles: string[]): void {
  const titleSource = session._titleSource;
  const originalFeed = titleSource.feed.bind(titleSource);
  let pending = "";
  titleSource.feed = (chunk: string) => {
    pending = `${pending}${String(chunk)}`.slice(-4096);
    const titlePattern = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    for (const match of pending.matchAll(titlePattern)) titles.push(match[1]);
    const lastBell = Math.max(pending.lastIndexOf("\x07"), pending.lastIndexOf("\x1b\\"));
    if (lastBell >= 0) pending = pending.slice(lastBell + 1);
    originalFeed(chunk);
  };
}

function copySanitizedRecording(tempDirectory: string): string | null {
  const recordingsDirectory = path.join(tempDirectory, "recordings");
  if (!fs.existsSync(recordingsDirectory)) return null;
  const recordings = fs.readdirSync(recordingsDirectory);
  if (recordings.length === 0) return null;
  const source = path.join(recordingsDirectory, recordings[0]);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "glissa-grok-probe-out-"));
  const output = path.join(outputDirectory, recordings[0]);
  const sanitized = fs.readFileSync(source, "utf8")
    .split(tempDirectory).join("<grok-probe>")
    .split(os.homedir()).join("<home>");
  fs.writeFileSync(output, sanitized, { encoding: "utf8", mode: 0o600 });
  return output;
}

function parseArgs(args: string[]): { keep: boolean; help: boolean } | null {
  if (args.length === 0) return { keep: false, help: false };
  if (args.length === 1 && args[0] === "--keep") return { keep: true, help: false };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { keep: false, help: true };
  return null;
}

async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  if (!options) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const resolvedBeforeIsolation = grok.resolveCommand();
  if (!resolvedBeforeIsolation.path) throw new Error("The native Grok binary is not installed.");
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "glissa-grok-probe-"));
  const projectDirectory = path.join(tempDirectory, "project");
  fs.mkdirSync(projectDirectory);
  const configPath = path.join(tempDirectory, "config.json");
  writeProbeConfig(configPath, projectDirectory);
  const builtRoot = makeProbePack(tempDirectory);
  const claudeHookProbe = writeClaudeHookProbe(tempDirectory);
  process.env.GLISSA_CONFIG = configPath;
  process.env.GROK_HOME = makeProbeGrokHome(tempDirectory, resolvedBeforeIsolation.path);
  process.env.GROK_DEFAULT_SELECTED_PERMISSION = "allow_once";
  const setupCode = runAgentSetupCli(["setup", "grok"]);
  if (setupCode !== 0) throw new Error("The isolated Grok hook setup failed.");

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on("request", backend.app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const session: ProbeSession | null = backend.getSession(SESSION_ID);
  if (!session) throw new Error(`the probe config did not produce a session named ${SESSION_ID}`);
  const hookEvents: string[] = [];
  const hookPayloads: HookRecord[] = [];
  const rawTitles: string[] = [];
  const stateChanges: StateChange[] = [];
  const spawnCalls: SpawnCall[] = [];
  let ptyOutput = "";
  session._packsBuiltRoot = builtRoot;
  session._spawnEnv = { ...(session._spawnEnv || {}), HOME: claudeHookProbe.childHome };
  const spawnPty = session._ptySpawn;
  session._ptySpawn = (file, spawnArgs, spawnOptions) => {
    spawnCalls.push({ file, args: [...spawnArgs], cwd: spawnOptions.cwd, env: { ...spawnOptions.env } });
    return spawnPty(file, spawnArgs, spawnOptions);
  };
  session.on("state-change", ({ from, to, event }: StateChange) => {
    stateChanges.push({ from, to, event });
    console.log(`  [state] ${from} -> ${to} (${event})`);
  });
  session.on("data", (data: string) => {
    ptyOutput = `${ptyOutput}${String(data)}`.slice(-65536);
  });
  const originalIngest = session.ingestHookSignal.bind(session);
  session.ingestHookSignal = (raw) => {
    if (raw?.event) hookEvents.push(raw.event);
    if (raw?.payload) hookPayloads.push({ event: raw.event, payload: raw.payload });
    return originalIngest(raw);
  };
  captureTitles(session, rawTitles);

  let keptRecording: string | null = null;
  try {
    console.log("\nSpawn:");
    await session.start();
    check("the spawn used the Grok adapter", session.agentId === "grok");
    check("the validated file minted a session token", typeof session._hookToken === "string");
    await waitForState(session, ["IDLE"], "idle composer");

    console.log("\nTurn:");
    const promptStateIndex = stateChanges.length;
    await delay(5000);
    session.write(PROMPT);
    await delay(1200);
    session.write("\r");
    await waitForState(session, ["WAITING"], "approval prompt");
    check("the prompt moved the card to RUNNING", stateChanges.slice(promptStateIndex).some((change) => change.to === "RUNNING"));
    check("permission Notification moved the card to WAITING", session.state === "WAITING");

    console.log("\nApproval:");
    session.write("\r");
    await waitForState(session, ["COMPLETE"], "turn completion");
    check("a turn-end hook completed the card", session.state === "COMPLETE");
    check("the hook child inherited GLISSA_HOOK_URL", hookEvents.includes("notification") && hookEvents.includes("stop"));
    const capturedId = session._resumeSessionId;
    const stopPayload = hookPayloads.findLast((entry) => entry.event === "stop" && entry.payload.reason === "end_turn");
    check("Stop carried reason end_turn", stopPayload?.payload.reason === "end_turn");
    check("the camelCase session id was a UUIDv7", isUuidV7(capturedId));
    console.log(`  [hook:stop] reason=${String(stopPayload?.payload.reason || "none")} answer=${answerFrom(stopPayload?.payload) || "none"}`);

    console.log("\nResume:");
    session.kill();
    await waitForState(session, ["DONE", "FAILED"], "PTY reap");
    check("restart requested a resumed spawn", session.restart());
    await waitForState(session, ["IDLE"], "resumed session");
    await delay(5000);
    session.write(PACK_PROMPT);
    await delay(1200);
    session.write("\r");
    await waitForState(session, ["COMPLETE"], "resumed pack turn");
    const resumedStopPayload = hookPayloads.findLast((entry) => entry.event === "stop" && entry.payload.reason === "end_turn");
    const resumedAnswer = answerFrom(resumedStopPayload?.payload);
    check("the --rules pointer let Grok read the pack data file", resumedAnswer?.toLowerCase() === SENTINEL_WORD);
    check("resume retained the same UUIDv7 id", session._resumeSessionId === capturedId);
    check("GROK_CLAUDE_HOOKS_ENABLED=false stopped the Claude hook", !fs.existsSync(claudeHookProbe.markerPath));
    check("the raw titles include a working shape", rawTitles.some(isWorkingTitle));
    check("the raw titles include an action-required shape", rawTitles.some((title) => grok.classifyTitle(title) === "awaiting-input"));
    check("the raw titles include an idle shape", rawTitles.some((title) => !isWorkingTitle(title) && grok.classifyTitle(title) === "unknown"));
    console.log(`  [answer:pack] ${resumedAnswer || "none"}`);
    console.log(`  [ids] captured=${capturedId} after-resume=${session._resumeSessionId}`);
    console.log(`  [claude-hook-fired] ${fs.existsSync(claudeHookProbe.markerPath) ? "yes" : "no"}`);
    for (const [index, call] of spawnCalls.entries()) {
      console.log(`  [argv:${index + 1}] ${JSON.stringify([call.file, ...call.args])}`);
    }
    check("both spawns carried the --rules pointer", spawnCalls.length === 2 && spawnCalls.every((call) => call.args.includes("--rules")));
    check("the resumed argv retained the UUIDv7 id", !!capturedId && !!spawnCalls[1]?.args.includes("-r") && spawnCalls[1].args.includes(capturedId));
    const authenticationLine = ptyOutput.split(/\r?\n/).find((line) => line.toLowerCase().includes("not authenticated"));
    if (authenticationLine) throw new Error(authenticationLine);
    if (options.keep) keptRecording = copySanitizedRecording(tempDirectory);
    console.log(`\nRecording: ${keptRecording || "none written"}`);
    console.log(`Hook events: ${[...new Set(hookEvents)].join(", ") || "none"}`);
    console.log(`Raw OSC titles: ${JSON.stringify([...new Set(rawTitles)])}`);
  } finally {
    try {
      session.kill();
    } catch { /* the process is exiting either way */ }
    await delay(1500);
    backend.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
