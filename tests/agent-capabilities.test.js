'use strict';

// M2 of docs/plan-agent-adapters.md: every Claude-only feature now asks the session's adapter first.
// Each test below turns exactly ONE capability off and pins that the feature is inert - no flag on the
// argv, no key in the settings file, no --add-dir, no injected context - while everything else about
// the spawn is unchanged. The claude-code side of each pair is the control: with the reference adapter
// every one of these still fires, which is what makes the gate a gate rather than a deletion.
//
// The fake adapter is a spread of the real one with capabilities overridden, injected through the
// Session `adapter` seam, because claude-code is still the only registered id.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Session } = require('../session/sessions');
const { SessionRecorder } = require('../session/session-recorder');
const { HookRouter } = require('../detection/hook-source');
const claudeCode = require('../session/adapters/claude-code');

const CLAUDE_MD_ENV = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';
delete process.env[CLAUDE_MD_ENV];

const RESUME_ID = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';

function fakePty(pid = 2147483646) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

// A second agent that is claude-code in every way except the capabilities named here, so a difference
// in the spawn can only have come from the gate under test.
function agentWithout(...disabled) {
  const capabilities = { ...claudeCode.capabilities };
  for (const capability of disabled) capabilities[capability] = false;
  return { ...claudeCode, id: 'test-agent', label: 'Test Agent', capabilities };
}

async function makeBuiltRoot(packs) {
  const builtRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-cap-packs-'));
  for (const [name, version] of Object.entries(packs)) {
    const currentDir = path.join(builtRoot, name, 'current');
    await fsp.mkdir(currentDir, { recursive: true });
    await fsp.writeFile(path.join(currentDir, 'CLAUDE.md'), `# ${name}\n`, 'utf8');
    await fsp.writeFile(path.join(currentDir, 'manifest.json'), JSON.stringify({ name, version }), 'utf8');
  }
  return builtRoot;
}

function makeSession(options) {
  const calls = [];
  const session = new Session({
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args, opts) => { calls.push({ file, args, env: opts.env }); return fakePty(); },
    ...options,
  });
  return { session, calls };
}

async function withHooks(options, run) {
  const hooksBaseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-cap-hooks-'));
  const { session, calls } = makeSession({
    hookRouter: new HookRouter(),
    getHookPort: () => 41234,
    hooksBaseDir,
    ...options,
  });
  try {
    await session.start();
    const settings = JSON.parse(fs.readFileSync(path.join(hooksBaseDir, options.id, 'settings.json'), 'utf8'));
    await run({ session, calls, settings });
  } finally {
    session.destroy();
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
  }
}

test('packs off: nothing is added to the argv, and the refusal is in the decision trace', async () => {
  const builtRoot = await makeBuiltRoot({ 'company-context': 'v-abc' });
  const { session, calls } = makeSession({
    id: 'no-packs', name: 'no-packs', adapter: agentWithout('packs'),
    packs: ['company-context'], packsBuiltRoot: builtRoot,
  });
  try {
    await session.start();
    assert.deepEqual(calls[0].args, [], 'no --add-dir');
    assert.equal(CLAUDE_MD_ENV in calls[0].env, false, 'and no CLAUDE.md env flag');
    assert.deepEqual(session.toSnapshot().packs, []);
    const decisions = session.getDebugState().decisions.filter((d) => d.kind === 'pack');
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, 'unsupported');
    assert.equal(decisions[0].name, 'company-context');
    assert.match(decisions[0].reason, /test-agent/);
    assert.equal(decisions[0].agent, 'test-agent', 'a non-default agent stamps its trace entries');
  } finally {
    session.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('packNotice off: a rebuild arms nothing and the hook response can never carry context', async () => {
  const builtRoot = await makeBuiltRoot({ 'company-context': 'v-abc' });
  const cases = [
    { adapter: claudeCode, armed: true },
    { adapter: agentWithout('packNotice'), armed: false },
  ];
  for (const { adapter, armed } of cases) {
    const { session } = makeSession({
      id: 'notice', name: 'notice', adapter, packs: ['company-context'], packsBuiltRoot: builtRoot,
    });
    try {
      await session.start();
      assert.deepEqual(session.toSnapshot().packs.map((p) => p.name), ['company-context'], 'the pack is still delivered');
      assert.equal(session.notePackUpdate('company-context', 'v-next'), armed);
      assert.equal(session.takePackNoticeContext() === null, !armed);
    } finally {
      session.destroy();
    }
  }
  await fsp.rm(builtRoot, { recursive: true, force: true });
});

test('statusLine off: planLimits injects no statusLine into the settings file', async () => {
  await withHooks({ id: 'sl-on', name: 'sl-on', planLimits: true }, ({ settings }) => {
    assert.equal(settings.statusLine.type, 'command', 'the control: claude-code still injects it');
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
      assert.ok(calls[0].env.PATH.startsWith(rtkDir) || calls[0].env.Path?.startsWith(rtkDir));
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

// The M2 acceptance pin: turning the seam on cost a Claude Code recording exactly one header field.
test('a claude-code recording differs only by the header agent field', async () => {
  const recorderBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-cap-rec-'));
  const { session } = makeSession({ id: 'rec', name: 'rec' });
  const recorder = new SessionRecorder({ name: 'rec', baseDir: recorderBase, recordData: false });
  session.setRecorder(recorder);
  try {
    await session.start();
    session.ingestHookSignal({ signal: 'ready', source: 'hook', ts: 1000, event: 'Stop', payload: {} });
    recorder.writeFooter('pty_exit', 0);
    await new Promise((resolve) => { recorder._stream.once('finish', resolve); recorder.close(); });
    const file = fs.readdirSync(recorderBase).find((entry) => entry.endsWith('.jsonl'));
    const records = fs.readFileSync(path.join(recorderBase, file), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));

    const header = records.find((r) => r.type === 'header');
    assert.deepEqual(Object.keys(header).sort(), ['agent', 'cols', 'config', 'records', 'rows', 'session', 'startedAt', 'type', 'version']);
    assert.equal(header.agent, 'claude-code');
    assert.deepEqual(Object.keys(header.config).sort(), ['cols', 'hooksInjected', 'rows'], 'the agent rides the header, not the config bag');
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
  const builtRoot = await makeBuiltRoot({ 'company-context': 'v-abc' });
  const { session } = makeSession({
    id: 'rec2', name: 'rec2', adapter: agentWithout('packs'), packs: ['company-context'], packsBuiltRoot: builtRoot,
  });
  const recorder = new SessionRecorder({ name: 'rec2', baseDir: recorderBase, recordData: false });
  session.setRecorder(recorder);
  try {
    await session.start();
    await new Promise((resolve) => { recorder._stream.once('finish', resolve); recorder.close(); });
    const file = fs.readdirSync(recorderBase).find((entry) => entry.endsWith('.jsonl'));
    const records = fs.readFileSync(path.join(recorderBase, file), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(records.find((r) => r.type === 'header').agent, 'test-agent');
    const decision = records.find((r) => r.type === 'decision');
    assert.equal(decision.agent, 'test-agent');
    assert.equal(decision.decision, 'unsupported');
  } finally {
    session.destroy();
    await fsp.rm(recorderBase, { recursive: true, force: true });
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});
