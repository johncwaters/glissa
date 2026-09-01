import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage, Server } from 'node:http';

import { createBackend } from '../server/backend.ts';
import { buildScorecards } from '../server/core/mill-metrics-core.ts';
import type { MillMetricSession } from '../shared/contracts/mill-metrics.ts';
import type { Session } from '../session/sessions.ts';
import type { HookSignal } from '../detection/hook-source.ts';

interface MetricEvent {
  kind: string;
  sessionId?: string;
  pack?: string;
  relPath?: string;
  promptClass?: string;
}

interface RecordsDocument {
  sessions: MillMetricSession[];
}

interface ReadHookPayload {
  tool_name?: string;
  tool_input?: { file_path?: string };
}
import {
  awaitBackendShutdown,
  closeServer,
  connectControl,
  findFreeHighPort,
  listen,
  makeClaudeConfig,
  removeHarnessTempDirectory,
  safeTextTail,
} from './support/backend-harness.ts';

const SESSION_ID = 'mill-metrics-smoke-session';
const PACK_NAME = 'mill-metrics-smoke-pack';
const PACK_REL_PATH = path.join('data', 'smoke.txt');
const PACK_VERSION = 'mill-metrics-smoke-v1';
const SENTINEL = 'smoke-opened';
const STEP_TIMEOUT_MS = 90000;
const HARD_TIMEOUT_MS = 180000;

let passed = 0;
let failed = 0;

function check(label: string, condition: unknown): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
    return;
  }
  console.error(`  FAIL  ${label}`);
  failed += 1;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(() => resolve(), ms); });
}

function writeProbeConfig(configPath: string, projectDirectory: string, port: number): void {
  fs.writeFileSync(configPath, `${JSON.stringify({
    port,
    projects: [{
      id: SESSION_ID,
      name: 'mill metrics smoke',
      path: projectDirectory,
      agent: 'claude-code',
      dangerouslySkipPermissions: false,
      packs: [PACK_NAME],
    }],
    teams: [],
    repoRoots: [],
    packsAutoRebuild: false,
    autoResume: false,
    worktreeAutoRebase: false,
    branchGc: { enabled: false },
    usage: { enabled: false },
    capture: { enabled: false },
  }, null, 2)}\n`, 'utf8');
}

function makeProbePack(tempDirectory: string) {
  const builtRoot = path.join(tempDirectory, 'packs', 'built');
  const currentDirectory = path.join(builtRoot, PACK_NAME, 'current');
  const dataDirectory = path.join(currentDirectory, 'data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(currentDirectory, 'CLAUDE.md'),
    '# Mill metrics smoke pack\n\nRead `data/smoke.txt` when asked for the smoke sentinel.\n',
    'utf8',
  );
  fs.writeFileSync(path.join(currentDirectory, PACK_REL_PATH), `${SENTINEL}\n`, 'utf8');
  fs.writeFileSync(
    path.join(currentDirectory, 'manifest.json'),
    JSON.stringify({ name: PACK_NAME, version: PACK_VERSION, tokenEstimate: 20 }, null, 2),
    'utf8',
  );
  return { builtRoot, packFile: path.join(currentDirectory, PACK_REL_PATH) };
}

function readMetricEvents(eventsDirectory: string): MetricEvent[] {
  if (!fs.existsSync(eventsDirectory)) return [];
  const events: MetricEvent[] = [];
  const eventFiles = fs.readdirSync(eventsDirectory)
    .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort();
  for (const eventFile of eventFiles) {
    const lines = fs.readFileSync(path.join(eventsDirectory, eventFile), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line) as MetricEvent);
    }
  }
  return events;
}

async function waitForValue<T>(readValue: () => T, label: string, timeoutMs = STEP_TIMEOUT_MS): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readValue();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function observeReadHookRequests(request: IncomingMessage, readHookPayloads: ReadHookPayload[]): void {
  const requestPath = String(request.url || '').split('?')[0]?.toLowerCase() ?? '';
  const expectedPath = `/hook/${SESSION_ID}/posttooluse`.toLowerCase();
  if (request.method !== 'POST' || requestPath !== expectedPath) return;
  let body = '';
  request.on('data', (chunk: Buffer) => {
    body += String(chunk);
  });
  request.on('end', () => {
    let payload: ReadHookPayload | null = null;
    try {
      payload = (body ? JSON.parse(body) : {}) as ReadHookPayload;
    } catch {
      return;
    }
    if (payload?.tool_name !== 'Read') return;
    readHookPayloads.push(payload);
  });
}

async function submitPrompt(session: Session, prompt: string): Promise<void> {
  session.write(prompt);
  await delay(300);
  session.write('\r');
}

function promptEventCount(events: MetricEvent[]): number {
  return events.filter((event) => event.kind === 'prompt' && event.sessionId === SESSION_ID).length;
}

async function main() {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-mill-metrics-smoke-'));
  const projectDirectory = path.join(tempDirectory, 'project');
  const configPath = path.join(tempDirectory, 'config.json');
  const eventsDirectory = path.join(tempDirectory, 'mill-metrics');
  const recordsPath = path.join(tempDirectory, 'mill-metrics.json');
  fs.mkdirSync(projectDirectory);

  const port = await findFreeHighPort();
  process.env.GLISSA_CONFIG = configPath;
  process.env.GLISSA_PORT = String(port);
  writeProbeConfig(configPath, projectDirectory, port);
  const { builtRoot, packFile } = makeProbePack(tempDirectory);
  const claudeConfigDirectory = makeClaudeConfig(tempDirectory, [projectDirectory]);
  let backend: ReturnType<typeof createBackend> | null = null;
  let controlSocket: Awaited<ReturnType<typeof connectControl>> | null = null;
  let server: Server | null = null;
  let session: Session | null = null;
  const hardTimeout = setTimeout(() => {
    console.error(`\nFAIL hard timeout after ${HARD_TIMEOUT_MS}ms`);
    try { session?.kill(); } catch {}
    try { controlSocket?.terminate(); } catch {}
    try { backend?.shutdown(); } catch {}
    try { server?.closeAllConnections(); } catch {}
    try { server?.close(); } catch {}
    removeHarnessTempDirectory(tempDirectory);
    process.exit(2);
  }, HARD_TIMEOUT_MS);

  let cleanupRun: Promise<void> | null = null;
  const cleanUp = () => {
    if (cleanupRun) return cleanupRun;
    cleanupRun = (async () => {
      clearTimeout(hardTimeout);
      try { session?.kill(); } catch {}
      try { controlSocket?.terminate(); } catch {}
      try { await awaitBackendShutdown(backend); } catch (error) {
        console.error(`  NOTE  backend cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try { await closeServer(server); } catch (error) {
        console.error(`  NOTE  server cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      removeHarnessTempDirectory(tempDirectory);
    })();
    return cleanupRun;
  };
  const cleanUpAndExit = async (signalName: string) => {
    console.error(`\nreceived ${signalName}, killing the session and removing ${tempDirectory}`);
    try { await cleanUp(); } catch (error) {
      console.error(`signal cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(130);
  };
  const onSigint = () => { void cleanUpAndExit('SIGINT'); };
  const onSigterm = () => { void cleanUpAndExit('SIGTERM'); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const readHookPayloads: ReadHookPayload[] = [];
  const hookSignals: HookSignal[] = [];
  const stateChanges: { from: string; to: string; event: string; detail: unknown }[] = [];
  const spawnCalls: { file: string; args: string[]; cwd?: string }[] = [];
  let ptyOutputTail = '';

  try {
    server = http.createServer();
    backend = createBackend(server, { staticDir: null, checkForUpdate: null });
    server.on('request', (request) => observeReadHookRequests(request, readHookPayloads));
    server.on('request', backend.app);
    await listen(server, port);

    session = backend.getSession(SESSION_ID);
    if (!session) throw new Error('the configured smoke session was not created');
    const probeSession = session;
    session._packsBuiltRoot = builtRoot;
    session._extraClaudeArgs = ['--model', 'haiku'];
    session._spawnEnv = {
      ...(session._spawnEnv || {}),
      CLAUDE_CONFIG_DIR: claudeConfigDirectory,
    };
    const spawnPty = session._ptySpawn;
    session._ptySpawn = (file: string, args: string[], options: { cwd?: string }) => {
      spawnCalls.push({ file, args: [...args], cwd: options.cwd });
      return spawnPty(file, args, options);
    };
    const originalIngest = session.ingestHookSignal.bind(session);
    session.ingestHookSignal = (raw: HookSignal) => {
      hookSignals.push(raw);
      return originalIngest(raw);
    };
    session.on('state-change', ({ from, to, event, detail }: { from: string; to: string; event: string; detail: unknown }) => {
      stateChanges.push({ from, to, event, detail });
      console.log(`  [state] ${from} -> ${to} (${event})`);
    });
    session.on('data', (chunk: unknown) => {
      ptyOutputTail = `${ptyOutputTail}${String(chunk)}`.slice(-16384);
    });

    controlSocket = await connectControl(port);

    console.log(`\nIsolation: ${tempDirectory}`);
    console.log(`Port: ${port}`);
    console.log('\nSpawn:');
    controlSocket.send(JSON.stringify({ type: 'start-session', id: SESSION_ID }));
    await waitForValue(() => probeSession.state === 'IDLE', 'the interactive Claude prompt');
    const spawnCall = spawnCalls[0];
    const addDirectoryIndex = spawnCall?.args.indexOf('--add-dir') ?? -1;
    check('the session spawned the real claude-code adapter', probeSession.agentId === 'claude-code');
    check('the spawn used the cheap haiku model', spawnCall?.args.includes('--model') && spawnCall.args.includes('haiku'));
    check(
      'the spawn delivered the throwaway pack through --add-dir',
      addDirectoryIndex >= 0 && spawnCall.args[addDirectoryIndex + 1] === path.dirname(path.dirname(packFile)),
    );
    check('the Read hook was injected for measurable pack delivery', probeSession._hooks.detectsPackReads());
    await delay(5000);
    if (probeSession.state === 'FAILED') throw new Error('Claude exited before the first prompt');

    console.log('\nFirst turn:');
    const firstPrompt = [
      `Use the Read tool to read the ${PACK_NAME} file at ${packFile}.`,
      `Answer with exactly one line containing ${SENTINEL}.`,
    ].join(' ');
    await submitPrompt(probeSession, firstPrompt);
    await waitForValue(
      () => hookSignals.filter((signal) => String(signal?.event).toLowerCase() === 'userpromptsubmit').length >= 1,
      'the first UserPromptSubmit hook',
    );
    await waitForValue(
      () => stateChanges.some(({ to }) => to === 'RUNNING' || to === 'WAITING'),
      'a hook-driven RUNNING or WAITING state',
    );
    await waitForValue(
      () => readHookPayloads.find((payload) => payload?.tool_name === 'Read'),
      'the real PostToolUse Read payload',
    );
    await waitForValue(
      () => readMetricEvents(eventsDirectory).find(
        (event) => event.kind === 'pack-read'
          && event.pack === PACK_NAME
          && event.relPath === PACK_REL_PATH,
      ),
      'the persisted pack-read event',
    );
    await waitForValue(() => probeSession.state === 'COMPLETE', 'the first turn to complete');
    check('the first prompt reached the hook-driven work cycle', probeSession.hookSeen === true);

    console.log('\nFollow-up turn:');
    await submitPrompt(probeSession, 'Answer with exactly one line containing done.');
    await waitForValue(
      () => hookSignals.filter((signal) => String(signal?.event).toLowerCase() === 'userpromptsubmit').length >= 2,
      'the second UserPromptSubmit hook',
    );
    await waitForValue(
      () => promptEventCount(readMetricEvents(eventsDirectory)) >= 2,
      'two persisted prompt classifications',
    );
    await waitForValue(() => probeSession.state === 'COMPLETE', 'the follow-up turn to complete');

    console.log('\nDashboard kill:');
    controlSocket.send(JSON.stringify({ type: 'kill', id: SESSION_ID }));
    await waitForValue(() => probeSession.state === 'DONE', 'the dashboard kill transition');
    await waitForValue(
      () => readMetricEvents(eventsDirectory).find(
        (event) => event.kind === 'session-end' && event.sessionId === SESSION_ID,
      ),
      'the persisted session-end event',
    );
    const recordsDocument = await waitForValue(() => {
      if (!fs.existsSync(recordsPath)) return null;
      const parsed = JSON.parse(fs.readFileSync(recordsPath, 'utf8')) as RecordsDocument;
      return parsed.sessions.length > 0 ? parsed : null;
    }, 'the persisted mill metrics session record');

    const events = readMetricEvents(eventsDirectory);
    const deliveredEvents = events.filter(
      (event) => event.kind === 'pack-delivered' && event.sessionId === SESSION_ID,
    );
    const readEvents = events.filter(
      (event) => event.kind === 'pack-read' && event.sessionId === SESSION_ID,
    );
    const prompts = events.filter(
      (event) => event.kind === 'prompt' && event.sessionId === SESSION_ID,
    );
    const sessionEndEvents = events.filter(
      (event) => event.kind === 'session-end' && event.sessionId === SESSION_ID,
    );
    const sessionRecords = recordsDocument.sessions.filter((record) => record.sessionId === SESSION_ID);
    const sessionRecord = sessionRecords[0];
    const packRecord = sessionRecord?.packs.find((pack) => pack.name === PACK_NAME);

    console.log('\nAssertions:');
    check('events JSONL contains pack-delivered for the smoke pack', deliveredEvents.length === 1 && deliveredEvents[0].pack === PACK_NAME);
    check('events JSONL contains pack-read with the pack name and relative path', readEvents.some((event) => event.pack === PACK_NAME && event.relPath === PACK_REL_PATH));
    check('events JSONL contains at least two prompt classifications', prompts.length >= 2 && prompts.every((event) => typeof event.promptClass === 'string'));
    check('events JSONL contains session-end', sessionEndEvents.length === 1);
    check('mill-metrics.json contains one smoke session record', sessionRecords.length === 1);
    check('the persisted pack record is opened', packRecord?.opened === true);
    check('the persisted pack record counted at least one file', (packRecord?.filesRead ?? 0) >= 1);
    check('the dashboard kill was classified as user-kill', sessionRecord?.disposition === 'user-kill');

    console.log('\nPostToolUse Read payload:');
    console.log(JSON.stringify(readHookPayloads[0], null, 2));
    console.log(`\nPrompt classes: ${prompts.map((event) => event.promptClass).join(', ')}`);
    console.log('\nScorecard:');
    console.log(JSON.stringify(buildScorecards(recordsDocument.sessions)[PACK_NAME], null, 2));
  } catch (error) {
    failed += 1;
    console.error(`\nFAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    if (ptyOutputTail) console.error(`PTY output tail: ${JSON.stringify(safeTextTail(ptyOutputTail, 4096))}`);
  } finally {
    await cleanUp();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
