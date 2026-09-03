
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend.ts';
import type { HookPayload } from '../shared/contracts/index.ts';
import type { Session } from '../session/sessions.ts';

interface ProbeSession extends Session {
  _hookToken?: string;
}

interface SpawnCall {
  file: string;
  args: string[];
  cwd: string | undefined;
}

const SESSION_ID = 'codex-probe-session';
const PACK_NAME = 'live-probe-pack';
const SENTINEL_WORD = 'velvetquartz';
const PROMPT = 'what sentinel word does the glissa context pack data file contain, answer with the word only';
const STEP_TIMEOUT_MS = 90000;

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean): void {
  if (condition) { console.log(`  PASS  ${label}`); passed += 1; return; }
  console.error(`  FAIL  ${label}`);
  failed += 1;
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function waitForState(session: Session, states: string[], label: string): Promise<string> {
  const wanted = new Set(states);
  if (wanted.has(session.state)) return Promise.resolve(session.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off('state-change', onChange);
      reject(new Error(`timed out waiting for ${label} (still ${session.state})`));
    }, STEP_TIMEOUT_MS);
    function onChange({ to }: { to: string }): void {
      if (!wanted.has(to)) return;
      clearTimeout(timer);
      session.off('state-change', onChange);
      resolve(to);
    }
    session.on('state-change', onChange);
  });
}

function makeProbeCodexHome(tmpDir: string, projectDir: string): string {
  const codexHome = path.join(tmpDir, 'codex-home');
  fs.mkdirSync(codexHome);
  const realAuth = path.join(os.homedir(), '.codex', 'auth.json');
  if (fs.existsSync(realAuth)) {
    try {
      fs.symlinkSync(realAuth, path.join(codexHome, 'auth.json'));
    } catch (err) {
      console.warn(`  NOTE  could not link ~/.codex/auth.json (${messageOf(err)}); codex may ask you to log in`);
    }
  }
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    `[projects.${JSON.stringify(projectDir)}]\ntrust_level = "trusted"\n`,
    'utf8',
  );
  return codexHome;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function writeProbeConfig(configPath: string, projectDir: string): void {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{
      id: SESSION_ID,
      name: 'codex probe',
      path: projectDir,
      agent: 'codex',
      dangerouslySkipPermissions: false,
      codexBypassHookTrust: true,
      packs: [PACK_NAME],
    }],
    teams: [],
    repoRoots: [],
    millEnabled: false,
    autoResume: false,
    worktreeAutoRebase: false,
    capture: { enabled: true },
  }, null, 2), 'utf8');
}

function makeProbePack(tmpDir: string): string {
  const builtRoot = path.join(tmpDir, 'packs', 'built');
  const currentDir = path.join(builtRoot, PACK_NAME, 'current');
  const dataDir = path.join(currentDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(currentDir, 'CLAUDE.md'),
    '# Glissa live probe pack\n\nFor sentinel questions, read `data/sentinel.txt`.\n',
    'utf8',
  );
  fs.writeFileSync(path.join(dataDir, 'sentinel.txt'), `${SENTINEL_WORD}\n`, 'utf8');
  fs.writeFileSync(
    path.join(currentDir, 'manifest.json'),
    JSON.stringify({ name: PACK_NAME, version: 'live-probe-v1', tokenEstimate: 20 }, null, 2),
    'utf8',
  );
  return builtRoot;
}

function answerFrom(payload: HookPayload | undefined): string | null {
  const answer = payload?.last_assistant_message;
  return typeof answer === 'string' ? answer.trim() : null;
}

function copySanitizedRecording(tmpDir: string): string | null {
  const recordingDir = path.join(tmpDir, 'recordings');
  if (!fs.existsSync(recordingDir)) return null;
  const recorded = fs.readdirSync(recordingDir);
  if (recorded.length === 0) return null;
  const source = path.join(recordingDir, recorded[0]);
  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-codex-probe-out-'));
  const keptRecording = path.join(keepDir, recorded[0]);
  const sanitized = fs.readFileSync(source, 'utf8')
    .split(tmpDir).join('<codex-probe>')
    .split(os.homedir()).join('<home>');
  fs.writeFileSync(keptRecording, sanitized, { encoding: 'utf8', mode: 0o600 });
  return keptRecording;
}

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-codex-probe-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const configPath = path.join(tmpDir, 'config.json');
  writeProbeConfig(configPath, projectDir);
  const builtRoot = makeProbePack(tmpDir);
  process.env.GLISSA_CONFIG = configPath;
  process.env.CODEX_HOME = makeProbeCodexHome(tmpDir, projectDir);

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });

  const session: ProbeSession | null = backend.getSession(SESSION_ID);
  if (!session) throw new Error(`the probe config did not produce a session named ${SESSION_ID}`);
  const hookEvents: string[] = [];
  const answers: string[] = [];
  const titleSignals: string[] = [];
  const spawnCalls: SpawnCall[] = [];
  session._packsBuiltRoot = builtRoot;
  const spawnPty = session._ptySpawn;
  session._ptySpawn = (file, args, options) => {
    spawnCalls.push({ file, args: [...args], cwd: options.cwd });
    return spawnPty(file, args, options);
  };
  session.on('state-change', ({ from, to, event }) => console.log(`  [state] ${from} -> ${to} (${event})`));

  const originalIngest = session.ingestHookSignal.bind(session);
  session.ingestHookSignal = (raw) => {
    if (raw?.event) hookEvents.push(raw.event);
    const answer = answerFrom(raw?.payload);
    if (answer) answers.push(answer);
    return originalIngest(raw);
  };
  session._titleSource.on('signal', (s: { signal: string }) => titleSignals.push(s.signal));

  try {
    console.log('\nSpawn:');
    await session.start();
    check('the spawn used the codex adapter', session.agentId === 'codex');
    check('hook injection produced a per-session token', typeof session._hookToken === 'string');
    await waitForState(session, ['RUNNING', 'IDLE'], 'first output');
    check('the session reached a live state after spawn', session.state !== 'DORMANT');

    console.log('\nPack turn:');
    await delay(6000);
    session.write(PROMPT);
    await delay(1500);
    session.write('\r');
    await waitForState(session, ['COMPLETE'], 'the turn to finish');
    check('the first turn answered with the data-file sentinel', answers.at(-1)?.toLowerCase() === SENTINEL_WORD);
    console.log(`  [answer:first] ${answers.at(-1) || '(none)'}`);

    const capturedId = session._resumeSessionId;
    check('a codex session id was captured from the hook payloads', typeof capturedId === 'string' && capturedId.length > 0);

    console.log('\nResume:');
    session.kill();
    await waitForState(session, ['DONE', 'FAILED'], 'the killed PTY to be reaped');
    hookEvents.length = 0;
    check('restart re-spawned the session', session.restart());
    await waitForState(session, ['RUNNING', 'IDLE'], 'the resumed session');
    await delay(6000);
    session.write(PROMPT);
    await delay(1500);
    session.write('\r');
    await waitForState(session, ['COMPLETE'], 'the resumed pack turn to finish');
    check('the resumed turn answered with the data-file sentinel', answers.at(-1)?.toLowerCase() === SENTINEL_WORD);
    check('the resume kept the same codex session id', session._resumeSessionId === capturedId);
    console.log(`  [answer:resume] ${answers.at(-1) || '(none)'}`);
    console.log(`  [ids]  captured=${capturedId} after-resume=${session._resumeSessionId}`);
    for (const [index, call] of spawnCalls.entries()) {
      console.log(`  [argv:${index + 1}] ${JSON.stringify([call.file, ...call.args])}`);
    }
    check('both spawns carried developer_instructions', spawnCalls.length === 2 && spawnCalls.every((call) => call.args.some((arg) => arg.startsWith('developer_instructions='))));
    check('the second spawn used codex resume', !!capturedId && !!spawnCalls[1]?.args.includes('resume') && spawnCalls[1].args.includes(capturedId));

    const keptRecording = copySanitizedRecording(tmpDir) || '(none written)';
    console.log(`\nRecording: ${keptRecording}`);
    console.log(`Hook events seen: ${[...new Set(hookEvents)].join(', ') || '(none)'}`);
    console.log(`Title signals seen: ${[...new Set(titleSignals)].join(', ') || '(none)'}`);
  } finally {
    try { session.kill(); } catch {  }
    await delay(1500);
    backend.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
