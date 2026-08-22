'use strict';

// Pack read telemetry end to end at the session seam: the extra PostToolUse matcher is injected only
// for a session that delivers packs, a Read callback bumps the delivered pack's count without
// touching detection, and the per-read callbacks stay OUT of a signals recording (the footer carries
// the aggregate instead). Uses the injected ptySpawn fake, so no real process is launched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Session } = require('../session/sessions');
const { SessionRecorder } = require('../session/session-recorder');
const { HookRouter, mapHookToSignal } = require('../detection/hook-source');
const { PACK_READ_TOOL_MATCHER, WAKEUP_TOOL_MATCHER } = require('../detection/settings-injector');

const HOOK_PORT = 45671;

function fakePty(pid = 2147483645) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

async function makeBuiltRoot(packs) {
  const builtRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-packreads-'));
  for (const [name, version] of Object.entries(packs)) {
    const currentDir = path.join(builtRoot, name, 'current');
    await fsp.mkdir(currentDir, { recursive: true });
    await fsp.writeFile(path.join(currentDir, 'CLAUDE.md'), `# ${name}\n`, 'utf8');
    await fsp.writeFile(path.join(currentDir, 'manifest.json'), JSON.stringify({ name, version }, null, 2), 'utf8');
  }
  return builtRoot;
}

// A Read hook callback exactly as Claude Code posts it, routed through the real signal mapper.
function readCallback(filePath, ts) {
  const payload = { tool_name: 'Read', tool_input: { file_path: filePath } };
  return { signal: mapHookToSignal('PostToolUse', payload), source: 'hook', ts: ts || Date.now(), event: 'PostToolUse', payload };
}

async function makeSession(overrides) {
  const hooksBaseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-packread-hooks-'));
  const session = new Session({
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
    hookRouter: new HookRouter(),
    getHookPort: () => HOOK_PORT,
    hooksBaseDir,
    ...overrides,
  });
  return { session, hooksBaseDir };
}

function readSettings(hooksBaseDir, id) {
  return JSON.parse(fs.readFileSync(path.join(hooksBaseDir, id, 'settings.json'), 'utf8'));
}

test('a session delivering packs gets a second PostToolUse entry matching Read', async () => {
  const builtRoot = await makeBuiltRoot({ glissa: 'v1' });
  const { session, hooksBaseDir } = await makeSession({
    id: 'reads-on', name: 'reads-on', packs: ['glissa'], packsBuiltRoot: builtRoot,
  });
  try {
    await session.start();
    const settings = readSettings(hooksBaseDir, 'reads-on');
    assert.deepEqual(settings.hooks.PostToolUse.map((entry) => entry.matcher), [WAKEUP_TOOL_MATCHER, PACK_READ_TOOL_MATCHER]);
    const readEntry = settings.hooks.PostToolUse[1];
    assert.equal(readEntry.hooks[0].type, 'http');
    assert.match(readEntry.hooks[0].url, /\/hook\/reads-on\/posttooluse\?t=/);
  } finally {
    session.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
  }
});

test('a session with no packs writes the pre-telemetry settings file byte for byte', async () => {
  // The whole opt-in claim: nothing about a pack-less session changes, down to the file bytes.
  const { session, hooksBaseDir } = await makeSession({ id: 'no-packs', name: 'no-packs' });
  const expected = JSON.stringify({
    hooks: {
      ...Object.fromEntries(require('../detection/settings-injector').HOOK_EVENTS.map((event) => [event, [{
        hooks: [{ type: 'http', url: `http://127.0.0.1:${HOOK_PORT}/hook/no-packs/${event.toLowerCase()}?t=TOKEN`, timeout: 5 }],
      }]])),
      PostToolUse: [{
        matcher: WAKEUP_TOOL_MATCHER,
        hooks: [{ type: 'http', url: `http://127.0.0.1:${HOOK_PORT}/hook/no-packs/posttooluse?t=TOKEN`, timeout: 5 }],
      }],
    },
  }, null, 2);
  try {
    await session.start();
    const raw = fs.readFileSync(path.join(hooksBaseDir, 'no-packs', 'settings.json'), 'utf8');
    assert.equal(raw.replace(/t=[0-9a-f]+/g, 't=TOKEN'), expected);
  } finally {
    session.destroy();
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
  }
});

test('packReadTelemetry: false drops the Read matcher and stops counting', async () => {
  const builtRoot = await makeBuiltRoot({ glissa: 'v1' });
  const { session, hooksBaseDir } = await makeSession({
    id: 'reads-off', name: 'reads-off', packs: ['glissa'], packsBuiltRoot: builtRoot, packReadTelemetry: false,
  });
  try {
    await session.start();
    const settings = readSettings(hooksBaseDir, 'reads-off');
    assert.deepEqual(settings.hooks.PostToolUse.map((entry) => entry.matcher), [WAKEUP_TOOL_MATCHER]);
    session.ingestHookSignal(readCallback(path.join(builtRoot, 'glissa', 'current', 'CLAUDE.md')));
    assert.equal(session.toSnapshot().packs[0].reads, 0);
  } finally {
    session.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
  }
});

test('a Read inside a delivered pack bumps that pack, a repo file does not', async () => {
  const builtRoot = await makeBuiltRoot({ glissa: 'v1', company: 'v2' });
  const { session, hooksBaseDir } = await makeSession({
    id: 'counting', name: 'counting', packs: ['glissa', 'company'], packsBuiltRoot: builtRoot,
  });
  try {
    await session.start();
    const packFile = path.join(builtRoot, 'glissa', 'current', 'CLAUDE.md');
    session.ingestHookSignal(readCallback(packFile, 1000));
    session.ingestHookSignal(readCallback(packFile.replace(/\\/g, '/'), 2000)); // the other slash kind still counts
    session.ingestHookSignal(readCallback(path.join(process.cwd(), 'AGENTS.md'), 3000));

    const packs = session.toSnapshot().packs;
    assert.deepEqual(packs, [
      { name: 'glissa', version: 'v1', reads: 2 },
      { name: 'company', version: 'v2', reads: 0 },
    ]);
    assert.equal(session.getDebugState().packs[0].lastReadAt, 2000);
    assert.equal(session.getDetectionStats().lastSignal, null, 'read telemetry never reaches detection');
  } finally {
    session.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
  }
});

test('taking a staleness notice arms readsSinceNotice, which then rides the snapshot', async () => {
  const builtRoot = await makeBuiltRoot({ glissa: 'v1' });
  const { session, hooksBaseDir } = await makeSession({
    id: 'notice', name: 'notice', packs: ['glissa'], packsBuiltRoot: builtRoot,
  });
  try {
    await session.start();
    const packFile = path.join(builtRoot, 'glissa', 'current', 'CLAUDE.md');
    session.ingestHookSignal(readCallback(packFile, 1000));
    assert.equal('readsSinceNotice' in session.toSnapshot().packs[0], false, 'unarmed until a notice is taken');

    assert.equal(session.notePackUpdate('glissa', 'v2'), true);
    assert.ok(session.takePackNoticeContext());
    assert.deepEqual(session.toSnapshot().packs, [{ name: 'glissa', version: 'v1', reads: 1, readsSinceNotice: 0 }]);

    session.ingestHookSignal(readCallback(packFile, 4000));
    assert.deepEqual(session.toSnapshot().packs, [{ name: 'glissa', version: 'v1', reads: 2, readsSinceNotice: 1 }]);
  } finally {
    session.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
  }
});

test('signals recording: no per-read hook records, the counts ride the footer instead', async () => {
  const builtRoot = await makeBuiltRoot({ glissa: 'v1' });
  const recorderBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-packread-rec-'));
  const { session, hooksBaseDir } = await makeSession({
    id: 'recorded', name: 'recorded', packs: ['glissa'], packsBuiltRoot: builtRoot,
  });
  const recorder = new SessionRecorder({ name: 'recorded', baseDir: recorderBase, recordData: false });
  session.setRecorder(recorder);
  try {
    await session.start();
    const packFile = path.join(builtRoot, 'glissa', 'current', 'CLAUDE.md');
    session.ingestHookSignal(readCallback(packFile, 1000));
    session.ingestHookSignal(readCallback(packFile, 1100));
    session.ingestHookSignal({ signal: 'ready', source: 'hook', ts: 1200, event: 'Stop', payload: {} });
    recorder.writeFooter('pty_exit', 0, { packReads: session.packReadSummary() });

    await new Promise((resolve) => { recorder._stream.once('finish', resolve); recorder.close(); });
    const file = fs.readdirSync(recorderBase).find((entry) => entry.endsWith('.jsonl'));
    const records = fs.readFileSync(path.join(recorderBase, file), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));

    const hooks = records.filter((r) => r.type === 'hook');
    assert.deepEqual(hooks.map((r) => r.event), ['Stop'], 'Read callbacks are suppressed at the signals level');
    const footer = records.find((r) => r.type === 'footer');
    assert.deepEqual(footer.packReads, [{ name: 'glissa', version: 'v1', reads: 2, lastReadAt: 1100, readsSinceNotice: null }]);
  } finally {
    session.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
    await fsp.rm(recorderBase, { recursive: true, force: true });
  }
});

test('a full capture keeps every Read callback (raw fidelity is its whole point)', async () => {
  const builtRoot = await makeBuiltRoot({ glissa: 'v1' });
  const recorderBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-packread-full-'));
  const { session, hooksBaseDir } = await makeSession({
    id: 'recorded-full', name: 'recorded-full', packs: ['glissa'], packsBuiltRoot: builtRoot,
  });
  const recorder = new SessionRecorder({ name: 'recorded-full', baseDir: recorderBase, recordData: true });
  session.setRecorder(recorder);
  try {
    await session.start();
    session.ingestHookSignal(readCallback(path.join(builtRoot, 'glissa', 'current', 'CLAUDE.md'), 1000));
    await new Promise((resolve) => { recorder._stream.once('finish', resolve); recorder.close(); });
    const file = fs.readdirSync(recorderBase).find((entry) => entry.endsWith('.jsonl'));
    const records = fs.readFileSync(path.join(recorderBase, file), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const hooks = records.filter((r) => r.type === 'hook' && r.event === 'PostToolUse');
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].payload.tool_name, 'Read');
  } finally {
    session.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
    await fsp.rm(recorderBase, { recursive: true, force: true });
  }
});
