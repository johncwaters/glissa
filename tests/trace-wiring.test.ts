import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { TraceCheckpoint, TraceRecord } from '../shared/contracts/trace.ts';
import { createTraceWiring, pruneTraceFiles } from '../server/trace-wiring.ts';
import { MAX_SUBAGENT_READ_BYTES } from '../server/core/trace-tail-core.ts';

const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-home-'));
process.env.CLAUDE_CONFIG_DIR = claudeHome;
const projectsRoot = path.join(claudeHome, 'projects');
fs.mkdirSync(projectsRoot, { recursive: true });

const POLL_MS = 2000;
const PRUNE_MS = 24 * 60 * 60 * 1000;

class TestTraceSession extends EventEmitter {
  id: string;

  constructor(id: string) {
    super();
    this.id = id;
  }
}

function silentLogger(): Pick<Console, 'log' | 'warn'> {
  return { log: () => {}, warn: () => {} };
}

function makeWorkspace(name: string): { configDirectory: string; projectDirectory: string } {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `glissa-trace-${name}-`));
  const projectDirectory = fs.mkdtempSync(path.join(projectsRoot, `${name}-`));
  return { configDirectory, projectDirectory };
}

function createHarness(configDirectory: string, nowMs = 10) {
  const timers: { fn: () => void; ms: number }[] = [];
  const wiring = createTraceWiring({
    configPath: path.join(configDirectory, 'config.json'),
    logger: silentLogger(),
    nowFn: () => nowMs,
    setIntervalFn: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      const handle = setTimeout(() => {}, 2 ** 30);
      handle.unref();
      return handle;
    },
  });

  async function fire(ms: number): Promise<void> {
    for (const timer of timers) {
      if (timer.ms !== ms) continue;
      timer.fn();
    }
    await wiring.whenIdle();
  }

  return {
    wiring,
    timers,
    poll: () => fire(POLL_MS),
    firePrune: () => fire(PRUNE_MS),
    tracePath: (glissaSessionId: string) => path.join(configDirectory, 'traces', `${glissaSessionId}.jsonl`),
    checkpointPath: (glissaSessionId: string) => path.join(configDirectory, 'traces', `${glissaSessionId}.checkpoint.json`),
  };
}

function transcriptLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function mainPrompt(text: string, uuid: string): string {
  return transcriptLine({
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: 'vendor-session',
    timestamp: '2026-08-22T18:47:28.724Z',
    message: { content: text },
  });
}

function subagentAnswer(text: string): string {
  return transcriptLine({
    type: 'assistant',
    uuid: 'subagent-answer',
    parentUuid: null,
    sessionId: 'vendor-session',
    agentId: 'a1',
    timestamp: '2026-08-22T18:47:35.724Z',
    message: { content: [{ type: 'text', text }] },
  });
}

function subagentStop(subagentPath: string) {
  return {
    event: 'subagentstop',
    payload: {
      session_id: 'vendor-session',
      agent_transcript_path: subagentPath,
      agent_id: 'a1',
      agent_type: 'general-purpose',
    },
  };
}

function readTrace(filePath: string) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => TraceRecord.parse(JSON.parse(line)));
}

function readCheckpoint(filePath: string) {
  return TraceCheckpoint.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function writeSubagentTranscript(projectDirectory: string, text: string): string {
  const subagentPath = path.join(projectDirectory, 'vendor-session', 'subagents', 'agent-a1.jsonl');
  fs.mkdirSync(path.dirname(subagentPath), { recursive: true });
  fs.writeFileSync(subagentPath, subagentAnswer(text), 'utf8');
  return subagentPath;
}

test('main and subagent transcript records append under the Glissa session id', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('capture');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = writeSubagentTranscript(projectDirectory, 'subagent answer');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);
  const appendedIds: string[] = [];
  harness.wiring.on('trace-appended', ({ id }: { id: string }) => appendedIds.push(id));

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('main prompt', 'prompt-id'), 'utf8');
  await harness.poll();
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'assistant']);
  assert.equal(records[0].kind === 'session' ? records[0].transcriptPath : null, transcriptPath);
  assert.equal(records[2].agentId, 'a1');
  assert.equal(records[2].agentType, 'general-purpose');
  assert.deepEqual(appendedIds, ['glissa-session-id', 'glissa-session-id', 'glissa-session-id']);

  const checkpoint = readCheckpoint(harness.checkpointPath('glissa-session-id'));
  assert.equal(checkpoint.offset, fs.statSync(transcriptPath).size);
  assert.deepEqual(checkpoint.ingestedSubagentPaths, [subagentPath]);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a repeated SubagentStop appends the sidechain once, after the main records it followed', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('order');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = writeSubagentTranscript(projectDirectory, 'subagent answer');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('launched an agent', 'prompt-id'), 'utf8');
  session.emit('hook-event', subagentStop(subagentPath));
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'assistant']);
  assert.equal(records[1].kind === 'prompt' ? records[1].text : null, 'launched an agent');

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a subagent transcript outside the bound session directory is refused', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('refuse');
  const strayProject = fs.mkdtempSync(path.join(projectsRoot, 'stray-'));
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const strayPath = path.join(strayProject, 'agent-a1.jsonl');
  fs.writeFileSync(strayPath, subagentAnswer('stray answer'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(strayPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session']);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a bound transcript outside the Claude projects root leaves no record and is never read', async () => {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-outside-'));
  const strayDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-stray-'));
  const strayTranscript = path.join(strayDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(strayTranscript, mainPrompt('secret prompt', 'prompt-id'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: strayTranscript });
  await harness.wiring.whenIdle();
  await harness.poll();

  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), false);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
  fs.rmSync(strayDirectory, { recursive: true, force: true });
});

test('a named pipe under the projects root is refused without wedging the lane', { skip: process.platform === 'win32' }, async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('fifo');
  const fifoPath = path.join(projectDirectory, 'vendor-session.jsonl');
  execFileSync('mkfifo', [fifoPath]);
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: fifoPath });
  await harness.wiring.whenIdle();

  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), false);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a restart resumes at the checkpoint instead of replaying retained history', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('restart');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('stored prompt', 'prompt-id'), 'utf8');
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await first.wiring.whenIdle();
  await first.wiring.stop();

  const second = createHarness(configDirectory);
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await second.wiring.whenIdle();
  await second.poll();
  await second.wiring.stop();

  const records = readTrace(first.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'session']);

  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a transcript shorter than the checkpoint restarts from zero and says so', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('reset');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('first prompt', 'prompt-one'), 'utf8');
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await first.wiring.whenIdle();
  await first.wiring.stop();

  fs.writeFileSync(transcriptPath, mainPrompt('short', 'prompt-two'), 'utf8');
  const second = createHarness(configDirectory);
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await second.wiring.whenIdle();
  await second.wiring.stop();

  const records = readTrace(first.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'session', 'prompt']);
  const reset = records[2];
  assert.equal(reset.kind === 'session' ? Boolean(reset.reason) : false, true);
  assert.equal(records[3].kind === 'prompt' ? records[3].text : null, 'short');

  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a rebind drains the old transcript before it follows the new one', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('rebind');
  const firstTranscript = path.join(projectDirectory, 'vendor-session.jsonl');
  const secondTranscript = path.join(projectDirectory, 'cleared-session.jsonl');
  fs.writeFileSync(firstTranscript, '', 'utf8');
  fs.writeFileSync(secondTranscript, mainPrompt('after the clear', 'prompt-two'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: firstTranscript });
  await harness.wiring.whenIdle();
  fs.appendFileSync(firstTranscript, mainPrompt('before the clear', 'prompt-one'), 'utf8');
  session.emit('claude-session-id', { id: 'cleared-session', vendor: 'claude', transcriptPath: secondTranscript });
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'session', 'prompt']);
  assert.equal(records[1].kind === 'prompt' ? records[1].text : null, 'before the clear');
  assert.equal(records[3].kind === 'prompt' ? records[3].text : null, 'after the clear');
  const checkpoint = readCheckpoint(harness.checkpointPath('glissa-session-id'));
  assert.equal(checkpoint.transcriptPath, secondTranscript);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('two terminals resumed onto one conversation keep their own trace files', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('shared-conversation');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('shared prompt', 'prompt-id'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const firstSession = new TestTraceSession('terminal-one');
  const secondSession = new TestTraceSession('terminal-two');
  harness.wiring.attachSession(firstSession);
  harness.wiring.attachSession(secondSession);

  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  firstSession.emit('exit', { exitCode: 0 });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('second prompt', 'prompt-two'), 'utf8');
  await harness.poll();

  assert.deepEqual(
    readTrace(harness.tracePath('terminal-one')).map((record) => record.kind),
    ['session', 'prompt'],
  );
  assert.deepEqual(
    readTrace(harness.tracePath('terminal-two')).map((record) => record.kind),
    ['session', 'prompt', 'prompt'],
  );

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('an exit and a teardown each drain what the transcript gained last', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('teardown');
  const exitTranscript = path.join(projectDirectory, 'exit-session.jsonl');
  const teardownTranscript = path.join(projectDirectory, 'teardown-session.jsonl');
  fs.writeFileSync(exitTranscript, '', 'utf8');
  fs.writeFileSync(teardownTranscript, '', 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const exitingSession = new TestTraceSession('exiting-session');
  const destroyedSession = new TestTraceSession('destroyed-session');
  harness.wiring.attachSession(exitingSession);
  harness.wiring.attachSession(destroyedSession);

  exitingSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: exitTranscript });
  destroyedSession.emit('claude-session-id', { id: 'other-session', vendor: 'claude', transcriptPath: teardownTranscript });
  await harness.wiring.whenIdle();
  fs.appendFileSync(exitTranscript, mainPrompt('written before the exit', 'prompt-one'), 'utf8');
  fs.appendFileSync(teardownTranscript, mainPrompt('written before the teardown', 'prompt-two'), 'utf8');
  exitingSession.emit('exit', { exitCode: 0 });
  exitingSession.emit('exit', { exitCode: 0 });
  destroyedSession.emit('teardown', { id: 'destroyed-session' });
  await harness.wiring.stop();

  assert.deepEqual(
    readTrace(harness.tracePath('exiting-session')).map((record) => record.kind),
    ['session', 'prompt'],
  );
  assert.deepEqual(
    readTrace(harness.tracePath('destroyed-session')).map((record) => record.kind),
    ['session', 'prompt'],
  );
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('stopping drains a session that never ended', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('shutdown');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('written at shutdown', 'prompt-id'), 'utf8');
  await harness.wiring.stop();

  assert.deepEqual(
    readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind),
    ['session', 'prompt'],
  );
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('an unsafe Glissa session id never becomes a trace path', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('unsafe');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('prompt', 'prompt-id'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('..');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();

  assert.equal(fs.existsSync(path.join(configDirectory, 'traces')), false);
  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('the age prune runs on start, on its interval, and spares a bound session', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('prune');
  const traceDirectory = path.join(configDirectory, 'traces');
  fs.mkdirSync(traceDirectory, { recursive: true });
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const harness = createHarness(configDirectory, Date.now());
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);
  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();

  const stalePath = path.join(traceDirectory, 'stale.jsonl');
  const staleCheckpointPath = path.join(traceDirectory, 'stale.checkpoint.json');
  const staleTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.writeFileSync(stalePath, '{}\n', 'utf8');
  fs.utimesSync(stalePath, staleTime, staleTime);
  for (const filePath of [harness.tracePath('glissa-session-id'), harness.checkpointPath('glissa-session-id')]) {
    fs.utimesSync(filePath, staleTime, staleTime);
  }
  await harness.wiring.start();
  await harness.wiring.whenIdle();

  assert.equal(fs.existsSync(stalePath), false);
  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), true);
  assert.equal(fs.existsSync(harness.checkpointPath('glissa-session-id')), true);
  assert.deepEqual(harness.timers.map((timer) => timer.ms), [PRUNE_MS, POLL_MS]);

  fs.writeFileSync(staleCheckpointPath, '{}\n', 'utf8');
  fs.utimesSync(staleCheckpointPath, staleTime, staleTime);
  await harness.firePrune();
  assert.equal(fs.existsSync(staleCheckpointPath), false);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('the age prune keeps files inside the retention window', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-retention-'));
  const oldPath = path.join(directory, 'old.jsonl');
  const currentPath = path.join(directory, 'current.jsonl');
  fs.writeFileSync(oldPath, '{}\n', 'utf8');
  fs.writeFileSync(currentPath, '{}\n', 'utf8');
  const now = Date.parse('2026-09-06T00:00:00.000Z');
  fs.utimesSync(oldPath, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));
  fs.utimesSync(currentPath, new Date(now - 6 * 24 * 60 * 60 * 1000), new Date(now - 6 * 24 * 60 * 60 * 1000));

  assert.equal(await pruneTraceFiles({ traceDirectory: directory, now }), 1);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(currentPath), true);
  fs.rmSync(directory, { recursive: true, force: true });
});


test('an append that fails keeps its records queued and leaves the checkpoint behind', {
  skip: process.getuid?.() === 0 ? 'root ignores file permissions' : false,
}, async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('append-failure');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('first prompt', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  const offsetBeforeFailure = readCheckpoint(harness.checkpointPath('glissa-session-id')).offset;

  fs.chmodSync(harness.tracePath('glissa-session-id'), 0o444);
  fs.appendFileSync(transcriptPath, mainPrompt('written while unwritable', 'prompt-two'), 'utf8');
  await harness.poll();

  assert.deepEqual(readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind), ['session', 'prompt']);
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).offset, offsetBeforeFailure);

  fs.chmodSync(harness.tracePath('glissa-session-id'), 0o600);
  await harness.poll();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'prompt']);
  assert.equal(records[2].kind === 'prompt' ? records[2].text : null, 'written while unwritable');
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).offset, fs.statSync(transcriptPath).size);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a batch appended without its checkpoint is not replayed on the next start', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('lost-checkpoint');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('appended before the crash', 'prompt-one'), 'utf8');
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await first.wiring.whenIdle();
  await first.wiring.stop();

  const stale = { ...readCheckpoint(first.checkpointPath('glissa-session-id')), offset: 0, offsetByTranscriptPath: {} };
  fs.writeFileSync(first.checkpointPath('glissa-session-id'), JSON.stringify(stale), 'utf8');

  const second = createHarness(configDirectory);
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await second.wiring.whenIdle();
  await second.wiring.stop();

  assert.deepEqual(
    readTrace(first.tracePath('glissa-session-id')).map((record) => record.kind),
    ['session', 'prompt', 'session'],
  );
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a transcript line written between the teardown and the stop still lands', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('teardown-window');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  session.emit('teardown', { id: 'glissa-session-id' });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('written while the pty was reaped', 'prompt-one'), 'utf8');
  await harness.wiring.stop();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt']);
  assert.equal(records[1].kind === 'prompt' ? records[1].text : null, 'written while the pty was reaped');
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('an exit in the tick of the first vendor id leaves no tailer behind', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('exit-race');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('written before the exit', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('exit', { exitCode: 0 });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('written after the exit', 'prompt-two'), 'utf8');
  await harness.poll();

  assert.deepEqual(
    readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind),
    ['session', 'prompt'],
  );

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a teardown in the tick of the first vendor id aborts the queued bind', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('teardown-race');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('never traced', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('teardown', { id: 'glissa-session-id' });
  await harness.wiring.whenIdle();
  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();

  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), false);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a rebind the validator refuses keeps the working binding', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('refused-rebind');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('before the refused rebind', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  session.emit('claude-session-id', {
    id: 'cleared-session',
    vendor: 'claude',
    transcriptPath: path.join(projectDirectory, 'not-on-disk-yet.jsonl'),
  });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('after the refused rebind', 'prompt-two'), 'utf8');
  await harness.poll();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'prompt']);
  assert.equal(records[2].kind === 'prompt' ? records[2].text : null, 'after the refused rebind');
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).transcriptPath, transcriptPath);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('returning to a conversation already traced resumes it instead of replaying it', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('return');
  const firstTranscript = path.join(projectDirectory, 'vendor-session.jsonl');
  const secondTranscript = path.join(projectDirectory, 'other-session.jsonl');
  fs.writeFileSync(firstTranscript, mainPrompt('first conversation', 'prompt-one'), 'utf8');
  fs.writeFileSync(secondTranscript, mainPrompt('second conversation', 'prompt-two'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: firstTranscript });
  await harness.wiring.whenIdle();
  session.emit('claude-session-id', { id: 'other-session', vendor: 'claude', transcriptPath: secondTranscript });
  await harness.wiring.whenIdle();
  fs.appendFileSync(firstTranscript, mainPrompt('back on the first', 'prompt-three'), 'utf8');
  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: firstTranscript });
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(
    records.map((record) => record.kind),
    ['session', 'prompt', 'session', 'prompt', 'session', 'prompt'],
  );
  assert.equal(records[5].kind === 'prompt' ? records[5].text : null, 'back on the first');
  const checkpoint = readCheckpoint(harness.checkpointPath('glissa-session-id'));
  assert.equal(checkpoint.offsetByTranscriptPath[secondTranscript], fs.statSync(secondTranscript).size);
  assert.equal(checkpoint.offsetByTranscriptPath[firstTranscript], fs.statSync(firstTranscript).size);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('the subagent root follows the resolved transcript, not the path the hook handed over', {
  skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false,
}, async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('symlinked-transcript');
  const realDirectory = path.join(projectDirectory, 'real');
  fs.mkdirSync(realDirectory, { recursive: true });
  const realTranscript = path.join(realDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(realTranscript, '', 'utf8');
  const linkedTranscript = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.symlinkSync(realTranscript, linkedTranscript);
  const strayPath = path.join(projectDirectory, 'agent-a1.jsonl');
  fs.writeFileSync(strayPath, subagentAnswer('answer beside the link'), 'utf8');
  const containedPath = path.join(realDirectory, 'agent-a2.jsonl');
  fs.writeFileSync(containedPath, subagentAnswer('answer beside the transcript'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: linkedTranscript });
  session.emit('hook-event', subagentStop(strayPath));
  await harness.wiring.whenIdle();
  session.emit('hook-event', subagentStop(containedPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'assistant']);
  assert.equal(records[0].kind === 'session' ? records[0].transcriptPath : null, realTranscript);
  assert.equal(records[1].kind === 'assistant' ? records[1].text : null, 'answer beside the transcript');

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a transcript sitting in the projects root itself never opens a sidechain beside it', async () => {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-root-transcript-'));
  const transcriptPath = path.join(projectsRoot, 'loose-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const siblingPath = path.join(projectsRoot, 'loose-agent-a1.jsonl');
  fs.writeFileSync(siblingPath, subagentAnswer('sibling of the projects root'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(siblingPath));
  await harness.wiring.whenIdle();

  assert.deepEqual(readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind), ['session']);

  await harness.wiring.stop();
  fs.rmSync(transcriptPath, { force: true });
  fs.rmSync(siblingPath, { force: true });
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a subagent transcript past the read bound leaves a notice, not a raw line', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('subagent-overflow');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = path.join(projectDirectory, 'agent-a1.jsonl');
  fs.writeFileSync(subagentPath, 'x'.repeat(MAX_SUBAGENT_READ_BYTES + 1), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'notice']);
  assert.equal(records[1].kind === 'notice' ? records[1].text : null, 'skipped 1 bytes of agent-a1.jsonl');

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

after(() => {
  fs.rmSync(claudeHome, { recursive: true, force: true });
});
