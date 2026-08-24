'use strict';

// Live verification of the Codex adapter (M3 of docs/plan-agent-adapters.md), run by hand against a
// REAL codex binary: node test/probe-codex-session.js
//
// It boots the real backend against a throwaway config (GLISSA_CONFIG), so the hook ingress, its
// per-session token check, the relay, the adapter's argv and the state machine are the shipped ones
// rather than fakes. It then drives one supervised session through the sequence M3 is accepted on:
//
//   spawn -> RUNNING (working) -> WAITING (awaiting-input) -> COMPLETE (ready) -> resume, same id
//
// The prompt asks codex for one shell command it cannot run unapproved, which is what produces the
// PermissionRequest hook; the probe answers the approval by writing to the PTY, exactly as an
// operator would from the dashboard.
//
// Costs one real codex turn. Requires codex on PATH and authenticated. The recording it leaves behind
// is the raw material for tests/fixtures/v2-codex-*.jsonl.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createBackend } = require('../server/backend');

const SESSION_ID = 'codex-probe-session';
const PROMPT = 'Run the shell command: touch ./codex-probe-approval.txt';
const STEP_TIMEOUT_MS = 90000;

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) { console.log(`  PASS  ${label}`); passed += 1; return; }
  console.error(`  FAIL  ${label}`);
  failed += 1;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Resolve when the session reaches one of `states`, or reject on the step timeout. Transitions are
// read off the session's own 'state-change' event, so the probe asserts the shipped state machine.
function waitForState(session, states, label) {
  const wanted = new Set(states);
  if (wanted.has(session.state)) return Promise.resolve(session.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off('state-change', onChange);
      reject(new Error(`timed out waiting for ${label} (still ${session.state})`));
    }, STEP_TIMEOUT_MS);
    function onChange({ to }) {
      if (!wanted.has(to)) return;
      clearTimeout(timer);
      session.off('state-change', onChange);
      resolve(to);
    }
    session.on('state-change', onChange);
  });
}

/*
 * The probe runs codex against a THROWAWAY CODEX_HOME so it can pre-trust its own temp project
 * directory (codex blocks on an interactive "do you trust this directory?" prompt otherwise, and that
 * trust is only readable from a config FILE, never from a `-c` override). auth.json is SYMLINKED
 * rather than copied, so the operator's credentials stay in one place and this probe leaves nothing
 * behind in ~/.codex. Probe-only: a supervised session in production uses the operator's real codex
 * home, and answers that trust prompt once, by hand, exactly as a Claude Code session answers its
 * workspace-trust dialog.
 */
function makeProbeCodexHome(tmpDir, projectDir) {
  const codexHome = path.join(tmpDir, 'codex-home');
  fs.mkdirSync(codexHome);
  const realAuth = path.join(os.homedir(), '.codex', 'auth.json');
  if (fs.existsSync(realAuth)) {
    try {
      fs.symlinkSync(realAuth, path.join(codexHome, 'auth.json'));
    } catch (err) {
      console.warn(`  NOTE  could not link ~/.codex/auth.json (${err.message}); codex may ask you to log in`);
    }
  }
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    `[projects.${JSON.stringify(projectDir)}]\ntrust_level = "trusted"\n`,
    'utf8',
  );
  return codexHome;
}

function writeProbeConfig(configPath, projectDir) {
  fs.writeFileSync(configPath, JSON.stringify({
    // Approvals must stay ON: the permissionless spawn form silences PermissionRequest, which is the
    // one awaiting-input signal codex has and the step this probe exists to exercise.
    // codexBypassHookTrust is what lets codex run Glissa's relay hooks at all; the probe's temp project
    // tree is empty, so nothing else can ride in on it. A real project opts in the same way, knowingly.
    projects: [{ id: SESSION_ID, name: 'codex probe', path: projectDir, agent: 'codex', dangerouslySkipPermissions: false, codexBypassHookTrust: true }],
    teams: [],
    repoRoots: [],
    packsAutoRebuild: false,
    autoResume: false,
    worktreeAutoRebase: false,
    // A full capture, so the recording carries the raw OSC titles the replay fixture is cut from.
    capture: { enabled: true },
  }, null, 2), 'utf8');
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-codex-probe-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const configPath = path.join(tmpDir, 'config.json');
  writeProbeConfig(configPath, projectDir);
  process.env.GLISSA_CONFIG = configPath;
  process.env.CODEX_HOME = makeProbeCodexHome(tmpDir, projectDir);

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const session = backend.getSession(SESSION_ID);
  const hookEvents = [];
  const titleSignals = [];
  session.on('state-change', ({ from, to, event }) => console.log(`  [state] ${from} -> ${to} (${event})`));

  const originalIngest = session.ingestHookSignal.bind(session);
  session.ingestHookSignal = (raw) => {
    if (raw?.event) hookEvents.push(raw.event);
    return originalIngest(raw);
  };
  session._titleSource.on('signal', (s) => titleSignals.push(s.signal));

  try {
    console.log('\nSpawn:');
    await session.start();
    check('the spawn used the codex adapter', session.agentId === 'codex');
    check('hook injection produced a per-session token', typeof session._hookToken === 'string');
    await waitForState(session, ['RUNNING', 'IDLE'], 'first output');
    check('the session reached a live state after spawn', session.state !== 'DORMANT');

    console.log('\nTurn:');
    // The composer treats a fast burst as a paste, so the newline is a separate write.
    await delay(6000);
    session.write(PROMPT);
    await delay(1500);
    session.write('\r');
    await waitForState(session, ['WAITING'], 'the approval prompt');
    check('PermissionRequest moved the card to WAITING', session.state === 'WAITING');
    check('the prompt kind is reported as a permission', session._pendingPromptKind === 'permission');
    // The Action Required title blinks at 1 Hz and the hook wins the race to WAITING, so the title
    // half of the same fact is checked after a beat rather than in the same tick.
    await delay(2500);
    check('the title source saw the Action Required state', titleSignals.includes('awaiting-input'));

    console.log('\nApproval:');
    // "1. Yes, proceed (y)" is the approval prompt's own accelerator.
    session.write('y');
    await waitForState(session, ['COMPLETE'], 'the turn to finish');
    check('Stop completed the card', session.state === 'COMPLETE');
    // The ingress lowercases the event into its route segment, so the recorded names are lowercase.
    check('UserPromptSubmit and Stop both arrived', hookEvents.includes('userpromptsubmit') && hookEvents.includes('stop'));

    const capturedId = session._resumeSessionId;
    check('a codex session id was captured from the hook payloads', typeof capturedId === 'string' && capturedId.length > 0);

    console.log('\nResume:');
    session.kill();
    await waitForState(session, ['DONE', 'FAILED'], 'the killed PTY to be reaped');
    hookEvents.length = 0;
    // restart() is the dashboard's own path out of DONE, and it re-spawns with `codex resume <id>`.
    check('restart re-spawned the session', session.restart());
    await waitForState(session, ['RUNNING', 'IDLE'], 'the resumed session');
    check('the resume kept the same codex session id (ids are stable across resume)', session._resumeSessionId === capturedId);
    console.log(`  [ids]  captured=${capturedId} after-resume=${session._resumeSessionId}`);

    // Copied out before the cleanup below removes the temp tree; this is what a fixture is cut from.
    // A full capture is the session's whole PTY stream, so it goes into a private directory (mkdtemp
    // creates 0700, with no window at a wider mode) and the file itself is 0600. Modes are advisory on
    // Windows, where the ACL of a per-user temp dir is what carries this.
    const recordingDir = path.join(tmpDir, 'recordings');
    const recorded = fs.existsSync(recordingDir) ? fs.readdirSync(recordingDir) : [];
    let keptRecording = '(none written)';
    if (recorded.length > 0) {
      const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-codex-probe-out-'));
      keptRecording = path.join(keepDir, recorded[0]);
      fs.copyFileSync(path.join(recordingDir, recorded[0]), keptRecording);
      fs.chmodSync(keptRecording, 0o600);
    }
    console.log(`\nRecording: ${keptRecording}`);
    console.log(`Hook events seen: ${[...new Set(hookEvents)].join(', ') || '(none)'}`);
    console.log(`Title signals seen: ${[...new Set(titleSignals)].join(', ') || '(none)'}`);
  } finally {
    try { session.kill(); } catch { /* the process is exiting either way */ }
    await delay(1500);
    backend.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // The temp tree holds a link to the operator's auth.json and a full PTY recording; neither may
    // outlive the probe in a world-readable /tmp.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
