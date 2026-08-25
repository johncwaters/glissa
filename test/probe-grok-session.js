"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createBackend } = require("../server/backend");
const { runAgentSetupCli } = require("../server/agent-setup-cli");
const grok = require("../session/adapters/grok");

const SESSION_ID = "grok-probe-session";
const PROMPT = "Run the shell command: touch ./grok-probe-approval.txt";
const STEP_TIMEOUT_MS = 90000;
const USAGE = "Usage: node test/probe-grok-session.js [--keep]\n--keep retains a sanitized copy of the full authenticated PTY transcript.";

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
    return;
  }
  console.error(`  FAIL  ${label}`);
  failed += 1;
}

function delay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function waitForState(session, states, label) {
  const wantedStates = new Set(states);
  if (wantedStates.has(session.state)) return Promise.resolve(session.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off("state-change", onStateChange);
      reject(new Error(`timed out waiting for ${label}, still ${session.state}`));
    }, STEP_TIMEOUT_MS);
    function onStateChange({ to }) {
      if (!wantedStates.has(to)) return;
      clearTimeout(timer);
      session.off("state-change", onStateChange);
      resolve(to);
    }
    session.on("state-change", onStateChange);
  });
}

function linkFile(source, target) {
  if (!fs.existsSync(source)) return false;
  fs.symlinkSync(source, target);
  return true;
}

function makeProbeGrokHome(tempDirectory, nativeBinaryPath) {
  const grokHome = path.join(tempDirectory, "grok-home");
  const binDirectory = path.join(grokHome, "bin");
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.symlinkSync(nativeBinaryPath, path.join(binDirectory, process.platform === "win32" ? "grok.exe" : "grok"));
  const authLinked = linkFile(path.join(os.homedir(), ".grok", "auth.json"), path.join(grokHome, "auth.json"));
  if (!authLinked) throw new Error("Grok credentials are unavailable. Sign in outside this probe, then run it again.");
  return grokHome;
}

function writeProbeConfig(configPath, projectDirectory) {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{
      id: SESSION_ID,
      name: "grok probe",
      path: projectDirectory,
      agent: "grok",
      dangerouslySkipPermissions: false,
    }],
    teams: [],
    repoRoots: [],
    packsAutoRebuild: false,
    autoResume: false,
    worktreeAutoRebase: false,
    capture: { enabled: true },
  }, null, 2), "utf8");
}

function captureTitles(session, titles) {
  const originalFeed = session._titleSource.feed.bind(session._titleSource);
  let pending = "";
  session._titleSource.feed = (chunk) => {
    pending = `${pending}${String(chunk)}`.slice(-4096);
    const titlePattern = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    for (const match of pending.matchAll(titlePattern)) titles.push(match[1]);
    const lastBell = Math.max(pending.lastIndexOf("\x07"), pending.lastIndexOf("\x1b\\"));
    if (lastBell >= 0) pending = pending.slice(lastBell + 1);
    originalFeed(chunk);
  };
}

function copySanitizedRecording(tempDirectory) {
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

function parseArgs(args) {
  if (args.length === 0) return { keep: false, help: false };
  if (args.length === 1 && args[0] === "--keep") return { keep: true, help: false };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { keep: false, help: true };
  return null;
}

async function main(args = process.argv.slice(2)) {
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
  process.env.GLISSA_CONFIG = configPath;
  process.env.GROK_HOME = makeProbeGrokHome(tempDirectory, resolvedBeforeIsolation.path);
  process.env.GROK_DEFAULT_SELECTED_PERMISSION = "allow_once";
  const setupCode = runAgentSetupCli(["setup", "grok"]);
  if (setupCode !== 0) throw new Error("The isolated Grok hook setup failed.");

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on("request", backend.app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const session = backend.getSession(SESSION_ID);
  const hookEvents = [];
  const rawTitles = [];
  session.on("state-change", ({ from, to, event }) => console.log(`  [state] ${from} -> ${to} (${event})`));
  const originalIngest = session.ingestHookSignal.bind(session);
  session.ingestHookSignal = (raw) => {
    if (raw?.event) hookEvents.push(raw.event);
    return originalIngest(raw);
  };
  captureTitles(session, rawTitles);

  let keptRecording = null;
  try {
    console.log("\nSpawn:");
    await session.start();
    check("the spawn used the Grok adapter", session.agentId === "grok");
    check("the validated file minted a session token", typeof session._hookToken === "string");
    await waitForState(session, ["RUNNING", "IDLE"], "first output");

    console.log("\nTurn:");
    await delay(5000);
    session.write(PROMPT);
    await delay(1200);
    session.write("\r");
    await waitForState(session, ["WAITING"], "approval prompt");
    check("permission Notification moved the card to WAITING", session.state === "WAITING");
    check("the hook child inherited GLISSA_HOOK_URL", hookEvents.includes("notification"));

    console.log("\nApproval:");
    session.write("\r");
    await waitForState(session, ["COMPLETE"], "turn completion");
    check("a turn-end hook completed the card", session.state === "COMPLETE");
    const capturedId = session._resumeSessionId;
    check("the camelCase session id was captured", typeof capturedId === "string" && capturedId.length > 0);

    console.log("\nResume:");
    session.kill();
    await waitForState(session, ["DONE", "FAILED"], "PTY reap");
    check("restart requested a resumed spawn", session.restart());
    await waitForState(session, ["RUNNING", "IDLE"], "resumed session");
    check("resume retained the same UUIDv7 id", session._resumeSessionId === capturedId);
    if (options.keep) keptRecording = copySanitizedRecording(tempDirectory);
    console.log(`\nRecording: ${keptRecording || "none written"}`);
    console.log(`Hook events: ${[...new Set(hookEvents)].join(", ") || "none"}`);
    console.log(`Raw OSC titles: ${[...new Set(rawTitles)].join(" | ") || "none"}`);
  } finally {
    try {
      session.kill();
    } catch {}
    await delay(1500);
    backend.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
