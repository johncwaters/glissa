import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session/sessions.ts';
import { SessionRecorder } from '../session/session-recorder.ts';
import { HookRouter } from '../detection/hook-source.ts';
import claudeCode from '../session/adapters/claude-code.ts';
import { fakePty } from './helpers/fake-pty.ts';
import type { AgentAdapter, AgentCapabilities } from '../session/adapters/index.ts';
import type { SessionOptions } from '../session/sessions.ts';

interface HookSettingsFile {
  statusLine?: { type?: string };
  hooks: Record<string, unknown>;
}

interface CapabilitySpawnCall {
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
}
const CLAUDE_MD_ENV = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';
delete process.env[CLAUDE_MD_ENV];

const RESUME_ID = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';

function agentWithout(...disabled: (keyof AgentCapabilities)[]): AgentAdapter {
  const capabilities: AgentCapabilities = { ...claudeCode.capabilities };
  for (const capability of disabled) capabilities[capability] = false;
  return { ...claudeCode, id: 'test-agent', label: 'Test Agent', capabilities };
}

async function makeBuiltRoot(packs: Record<string, string>) {
  const builtRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-cap-packs-'));
  for (const [name, version] of Object.entries(packs)) {
    const currentDir = path.join(builtRoot, name, 'current');
    await fsp.mkdir(currentDir, { recursive: true });
    await fsp.writeFile(path.join(currentDir, 'CLAUDE.md'), `# ${name}\n`, 'utf8');
    await fsp.writeFile(path.join(currentDir, 'manifest.json'), JSON.stringify({ name, version }), 'utf8');
  }
  return builtRoot;
}

function makeSession(options: Partial<SessionOptions> & { id: string; name: string }) {
  const calls: CapabilitySpawnCall[] = [];
  const session = new Session({
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args, opts) => { calls.push({ file, args, env: opts.env ?? {} }); return fakePty(); },
    ...options,
  });
  return { session, calls };
}

async function withHooks(
  options: Partial<SessionOptions> & { id: string; name: string },
  run: (context: { session: Session; settings: HookSettingsFile; calls: CapabilitySpawnCall[] }) => void,
) {
  const hooksBaseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-cap-hooks-'));
  const { session, calls } = makeSession({
    hookRouter: new HookRouter(),
    getHookPort: () => 41234,
    hooksBaseDir,
    ...options,
  });
  try {
    await session.start();
    const settings = JSON.parse(fs.readFileSync(path.join(hooksBaseDir, options.id, 'settings.json'), 'utf8')) as HookSettingsFile;
    await run({ session, calls, settings });
  } finally {
    session.destroy();
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
  }
}

test('packs off: nothing is added to the argv, and the refusal is in the decision trace', async () => {
  const builtRoot = await makeBuiltRoot({ 'house-rules': 'v-abc' });
  const { session, calls } = makeSession({
    id: 'no-packs', name: 'no-packs', adapter: agentWithout('packs'),
    packs: ['house-rules'], packsBuiltRoot: builtRoot,
  });
  try {
    await session.start();
    assert.deepEqual(calls[0].args, [], 'no --add-dir');
    assert.equal(CLAUDE_MD_ENV in calls[0].env, false, 'and no CLAUDE.md env flag');
    assert.deepEqual(session.toSnapshot().packs, []);
    const decisions = session.getDebugState().decisions.filter((d) => d.kind === 'pack');
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, 'unsupported');
    assert.equal(decisions[0].name, 'house-rules');
    assert.match(String(decisions[0].reason), /test-agent/);
    assert.equal(decisions[0].agent, 'test-agent', 'a non-default agent stamps its trace entries');
  } finally {
    session.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('packNotice off: a rebuild arms nothing and the hook response can never carry context', async () => {
  const builtRoot = await makeBuiltRoot({ 'house-rules': 'v-abc' });
  const cases = [
    { adapter: claudeCode, armed: true },
    { adapter: agentWithout('packNotice'), armed: false },
  ];
  for (const { adapter, armed } of cases) {
    const { session } = makeSession({
      id: 'notice', name: 'notice', adapter, packs: ['house-rules'], packsBuiltRoot: builtRoot,
    });
    try {
      await session.start();
      assert.deepEqual(session.toSnapshot().packs.map((p) => p.name), ['house-rules'], 'the pack is still delivered');
      assert.equal(session.notePackUpdate('house-rules', 'v-next'), armed);
      assert.equal(session.takePackNoticeContext() === null, !armed);
    } finally {
      session.destroy();
    }
  }
  await fsp.rm(builtRoot, { recursive: true, force: true });
});

test('statusLine off: planLimits injects no statusLine into the settings file', async () => {
  await withHooks({ id: 'sl-on', name: 'sl-on', planLimits: true }, ({ settings }) => {
    assert.equal(settings.statusLine?.type, 'command', 'the control: claude-code still injects it');
  });
  await withHooks({ id: 'sl-off', name: 'sl-off', planLimits: true, adapter: agentWithout('statusLine') }, ({ settings }) => {
    assert.equal('statusLine' in settings, false);
  });
});

test('rtk off: no PreToolUse hook and no PATH prepend, even with a resolved binary', async () => {
  const rtkDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-cap-rtk-'));
  const rtkPath = path.join(rtkDir, 'rtk.exe');
  await fsp.writeFile(rtkPath, '', 'utf8');
  try {
    await withHooks({ id: 'rtk-on', name: 'rtk-on', rtkPath }, ({ settings, calls }) => {
      assert.ok(settings.hooks.PreToolUse, 'the control: claude-code still injects the rtk hook');
      assert.ok(calls[0].env.PATH?.startsWith(rtkDir) || calls[0].env.Path?.startsWith(rtkDir));
    });
    await withHooks({ id: 'rtk-off', name: 'rtk-off', rtkPath, adapter: agentWithout('rtk') }, ({ settings, calls }) => {
      assert.equal('PreToolUse' in settings.hooks, false);
      const pathValue = calls[0].env.PATH || calls[0].env.Path || '';
      assert.equal(pathValue.startsWith(rtkDir), false);
    });
  } finally {
    await fsp.rm(rtkDir, { recursive: true, force: true });
  }
});

test('antiSlop off: no --append-system-prompt reaches the argv', async () => {
  const { session, calls } = makeSession({
    id: 'slop', name: 'slop', antiSlopPrompt: true, adapter: agentWithout('antiSlop'),
  });
  try {
    await session.start();
    assert.deepEqual(calls[0].args, []);
  } finally {
    session.destroy();
  }
});

test('resume off: the bound conversation is kept but never becomes a spawn flag', async () => {
  const { session, calls } = makeSession({
    id: 'resume', name: 'resume', resumeSessionId: RESUME_ID, adapter: agentWithout('resume'),
  });
  try {
    await session.start();
    assert.deepEqual(calls[0].args, []);
    assert.equal(session.toSnapshot().resumeSessionId, RESUME_ID, 'the binding is not silently dropped');
  } finally {
    session.destroy();
  }
});

test('backgroundAgents off: subagent signals never gate a completion', async () => {
  const { session } = makeSession({ id: 'gate', name: 'gate', adapter: agentWithout('backgroundAgents') });
  try {
    session.ingestHookSignal({ signal: 'subagent-start', source: 'hook', ts: 1000, event: 'SubagentStart', payload: { agent_id: 'a1' } });
    session.ingestHookSignal({ signal: 'ready', source: 'hook', ts: 1100, event: 'Stop', payload: { background_tasks: [{ id: 't1', type: 'teammate', status: 'running' }] } });
    assert.equal(session.toSnapshot().activeAgents, 0);
  } finally {
    session.destroy();
  }
});

test('the snapshot names the agent, defaulting to claude-code', async () => {
  const { session } = makeSession({ id: 'snap', name: 'snap' });
  const { session: other } = makeSession({ id: 'snap2', name: 'snap2', adapter: agentWithout() });
  try {
    assert.equal(session.toSnapshot().agent, 'claude-code');
    assert.equal(other.toSnapshot().agent, 'test-agent');
  } finally {
    session.destroy();
    other.destroy();
  }
});

test('a claude-code recording differs only by the header agent field', async () => {
  const recorderBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-cap-rec-'));
  const { session } = makeSession({ id: 'rec', name: 'rec' });
  const recorder = new SessionRecorder({ name: 'rec', baseDir: recorderBase, recordData: false });
  session.setRecorder(recorder);
  try {
    await session.start();
    session.ingestHookSignal({ signal: 'ready', source: 'hook', ts: 1000, event: 'Stop', payload: {} });
    recorder.writeFooter('pty_exit', 0);
    await new Promise<void>((resolve) => { recorder._stream?.once('finish', () => resolve()); recorder.close(); });
    const file = fs.readdirSync(recorderBase).find((entry) => entry.endsWith('.jsonl'));
    const records = fs.readFileSync(path.join(recorderBase, String(file)), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

    const header = records.find((r) => r.type === 'header');
    assert.deepEqual(Object.keys(header ?? {}).sort(), ['agent', 'cols', 'config', 'records', 'rows', 'session', 'startedAt', 'type', 'version']);
    assert.equal(header?.agent, 'claude-code');
    assert.deepEqual(Object.keys((header?.config ?? {}) as Record<string, unknown>).sort(), ['cols', 'hooksInjected', 'rows'], 'the agent rides the header, not the config bag');
    for (const record of records.filter((r) => r.type !== 'header')) {
      assert.equal('agent' in record, false, `${record.type} record must be untouched`);
    }
  } finally {
    session.destroy();
    await fsp.rm(recorderBase, { recursive: true, force: true });
  }
});

test('a non-default agent stamps its decision records, so a recording says which vocabulary it holds', async () => {
  const recorderBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-cap-rec2-'));
  const builtRoot = await makeBuiltRoot({ 'house-rules': 'v-abc' });
  const { session } = makeSession({
    id: 'rec2', name: 'rec2', adapter: agentWithout('packs'), packs: ['house-rules'], packsBuiltRoot: builtRoot,
  });
  const recorder = new SessionRecorder({ name: 'rec2', baseDir: recorderBase, recordData: false });
  session.setRecorder(recorder);
  try {
    await session.start();
    await new Promise<void>((resolve) => { recorder._stream?.once('finish', () => resolve()); recorder.close(); });
    const file = fs.readdirSync(recorderBase).find((entry) => entry.endsWith('.jsonl'));
    const records = fs.readFileSync(path.join(recorderBase, String(file)), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.find((r) => r.type === 'header')?.agent, 'test-agent');
    const decision = records.find((r) => r.type === 'decision');
    assert.equal(decision?.agent, 'test-agent');
    assert.equal(decision?.decision, 'unsupported');
  } finally {
    session.destroy();
    await fsp.rm(recorderBase, { recursive: true, force: true });
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});
