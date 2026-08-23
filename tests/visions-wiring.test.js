'use strict';

// The visions lane, at both altitudes: the wiring driven directly on injected timers (debounce
// coalescing, save boundary, cleanup, malformed frames), and a REAL backend boot proving the
// /visions upgrade is served on the local listener when enabled, inert when the config says nothing,
// and refused on the remote listener even when enabled.
//
// SAFETY: every boot points at a throwaway temp config with ZERO projects via GLISSA_CONFIG, like
// every other backend boot test (the boot worktree reconcile would otherwise touch real repos).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend');
const { createConfigStore, BOOLEAN_KEYS, STRING_KEYS, TIMEOUT_KEYS } = require('../server/config-store');
const { DIGEST_BUDGET_CHARS, createVisionsWiring, VISIONS_DEBOUNCE_MS } = require('../server/visions-wiring');

const MARKDOWN_URI = 'file:///tmp/plan-visions.md';
const PROJECT_ID = 'e1f4c0de-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = 'e1f4c0de-0000-4000-8000-000000000002';
const SCRIPT_URI = 'file:///tmp/app.js';
const CLEAN_MARKDOWN = '# Title\n\nA line with nothing wrong.\n';
const REPEATED_WORD_MARKDOWN = '# Title\n\nA line with with a repeat.\n';

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
}

// Only the uris the tab currently has a findings section for, which is what the sweep tests assert on.
function findingSections(wiring) {
  return wiring.documentsSnapshot().filter((entry) => entry.diagnostics.length > 0);
}

// --- Wiring driven directly (injected timers, no sockets) ---

function fakeTimers() {
  let nextId = 1;
  const pendingById = new Map();
  return {
    setTimeoutFn: (fn) => {
      const id = nextId++;
      pendingById.set(id, fn);
      return { id, unref() { return this; } };
    },
    clearTimeoutFn: (timer) => { if (timer) pendingById.delete(timer.id); },
    runPending: () => {
      const jobs = [...pendingById.values()];
      pendingById.clear();
      for (const job of jobs) job();
    },
    get pendingCount() { return pendingById.size; },
    get pendingIds() { return [...pendingById.keys()]; },
  };
}

const FIXED_TS = 1700000000000;

function drivenConnection(options = {}) {
  const timers = fakeTimers();
  const warnings = [];
  const notes = [];
  const sent = [];
  const broadcasts = [];
  const clock = { now: FIXED_TS };
  const wiring = createVisionsWiring({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: () => clock.now,
    logger: { warn: (message) => warnings.push(message), log: (message) => notes.push(message) },
    broadcast: (message) => broadcasts.push(message),
    ...options,
  });
  const connection = wiring.openConnection({ send: (message) => sent.push(message) });
  const lsp = (method, params) => connection.handleFrame(JSON.stringify({ type: 'lsp', method, params }));
  return { wiring, connection, timers, warnings, notes, sent, broadcasts, lsp, clock };
}

function tempIntentStatePath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-visions-intent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'visions-intent.json');
}

function countingFsPromises() {
  const writes = [];
  return {
    writes,
    fsPromises: {
      mkdir: (...args) => fs.promises.mkdir(...args),
      writeFile: (...args) => {
        writes.push(args);
        return fs.promises.writeFile(...args);
      },
      rename: (...args) => fs.promises.rename(...args),
      rm: (...args) => fs.promises.rm(...args),
    },
  };
}

function didOpenParams(uri, languageId, text) {
  return { textDocument: { uri, languageId, version: 1, text } };
}

function didChangeParams(uri, version, text) {
  return { textDocument: { uri, version }, contentChanges: [{ text }] };
}

function rangedChangeParams(uri, version, contentChanges) {
  return { textDocument: { uri, version }, contentChanges };
}

/*
 * The staleness defect this pins: an incremental didChange used to be refused outright, so the mirrored
 * buffer stayed frozen at its didOpen text, no sweep was ever scheduled, and every tier below read a
 * document the carbon unit had already moved on from.
 */
test('a didChange carrying ranges is applied and sweeps the spliced text', (t) => {
  const { wiring, timers, sent, warnings, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', '# Title\n\nA line with a repeat.\n'));
  timers.runPending();
  assert.deepEqual(sent[0].params.diagnostics, [], 'the opened text is clean');

  lsp('textDocument/didChange', rangedChangeParams(MARKDOWN_URI, 2, [
    { range: { start: { line: 2, character: 12 }, end: { line: 2, character: 12 } }, text: 'with ' },
  ]));
  assert.equal(timers.pendingCount, 1, 'the applied change schedules a sweep');

  timers.runPending();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].params.diagnostics.map((d) => d.code), ['repeated-word'], 'the sweep read the spliced text');
  assert.deepEqual(warnings, [], 'and nothing was refused');
});

test('a malformed range is refused with the uri, version, change index and range in the line', (t) => {
  const { wiring, timers, sent, warnings, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();

  lsp('textDocument/didChange', rangedChangeParams(MARKDOWN_URI, 7, [
    { range: { start: { line: 0, character: 0 } }, text: 'ignored' },
    { range: { start: { line: 3, character: 1 }, end: { line: 0, character: 0 } }, text: 'corrupt' },
  ]));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ignored textDocument\/didChange: invalid-range/);
  assert.match(warnings[0], /uri=file:\/\/\/tmp\/plan-visions\.md/);
  assert.match(warnings[0], /version=7/);
  assert.match(warnings[0], /change=0/);
  assert.match(warnings[0], /range=0:0-\?/);
  assert.equal(sent.length, 1, 'a refused frame publishes nothing new');
});

// Per-keystroke chatter is debug-gated, and even then it carries SIZES: buffer content never reaches
// a log line, at any level.
test('the didChange and debounced-sweep lines are debug-gated and name sizes rather than text', (t) => {
  const secret = '# Title\n\nA sentence nothing should ever log.\n';
  const quiet = drivenConnection();
  t.after(() => quiet.wiring.stop());
  quiet.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  quiet.lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, secret));
  quiet.timers.runPending();
  assert.equal(quiet.notes.some((line) => line.includes('didChange')), false, 'nothing per keystroke with debug off');
  assert.equal(quiet.notes.some((line) => line.includes('swept')), false, 'the debounced sweep runs at the same cadence');

  const loud = drivenConnection({ debug: () => true });
  t.after(() => loud.wiring.stop());
  loud.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  loud.lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, secret));
  loud.timers.runPending();
  const changeLine = loud.notes.find((line) => line.includes('didChange'));
  assert.match(changeLine, new RegExp(`v2 \\(1 changes, ${secret.length} chars\\)`));
  assert.ok(loud.notes.some((line) => line.includes('swept')), 'and the sweep line appears with debug on');
  assert.equal(loud.notes.some((line) => line.includes('nothing should ever log')), false);
});

// A logging decision must never fault the frame it rode in on.
test('a debug getter that throws reads as debug off rather than dropping the frame', (t) => {
  const { wiring, timers, sent, warnings, notes, lsp } = drivenConnection({
    debug: () => { throw new Error('settings unavailable'); },
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, REPEATED_WORD_MARKDOWN));
  timers.runPending();
  assert.deepEqual(warnings, [], 'the throw never reaches the frame handler');
  assert.equal(notes.some((line) => line.includes('didChange')), false, 'and it reads as off');
  assert.equal(sent.length, 1, 'the sweep still published');
});

// A save is operator-paced, so it keeps the one always-visible sweep marker.
test('a save sweep is reported at note level even with debug off', (t) => {
  const { wiring, notes, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  assert.ok(notes.some((line) => line.includes(`swept ${MARKDOWN_URI} on save: 1 findings`)), `saw ${JSON.stringify(notes)}`);
});

test('intent lines name the source and the size, never the sentence', (t) => {
  const statement = 'a plan doc nobody should find quoted in a log file';
  const { wiring, notes } = drivenConnection();
  t.after(() => wiring.stop());

  wiring.applyModelIntent(statement);
  const intentLines = notes.filter((line) => line.includes('intent '));
  assert.deepEqual(intentLines, [`[visions] intent model-set for all projects (${statement.length} chars)`]);
  assert.equal(notes.some((line) => line.includes('nobody should find')), false);
});

test('a stale didChange names both versions in the line it logs', (t) => {
  const { wiring, warnings, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', { textDocument: { uri: MARKDOWN_URI, languageId: 'markdown', version: 9, text: CLEAN_MARKDOWN } });
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 4, REPEATED_WORD_MARKDOWN));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /stale-version \(uri=.+ incoming=4 current=9\)/);
});

test('a burst of markdown edits coalesces into one sweep of the final text', (t) => {
  const { wiring, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, '# Title\n\nA line\n'));
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 3, REPEATED_WORD_MARKDOWN));
  assert.equal(timers.pendingCount, 1, 'one document, one pending sweep');
  assert.deepEqual(sent, [], 'nothing publishes before the quiet window');

  timers.runPending();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'publishDiagnostics');
  assert.equal(sent[0].params.uri, MARKDOWN_URI);
  assert.deepEqual(sent[0].params.diagnostics.map((d) => d.code), ['repeated-word']);
});

test('two open documents debounce independently', (t) => {
  const { wiring, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  const otherUri = 'file:///tmp/other.markdown';
  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didOpen', didOpenParams(otherUri, undefined, REPEATED_WORD_MARKDOWN));
  assert.equal(timers.pendingCount, 2, 'a .markdown extension is markdown even with no languageId');

  timers.runPending();
  assert.deepEqual(sent.map((msg) => msg.params.uri).sort(), [MARKDOWN_URI, otherUri].sort());
});

test('a save publishes at once instead of waiting out the quiet window', (t) => {
  const { wiring, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  assert.equal(sent.length, 1, 'the save is the pause boundary');
  assert.equal(timers.pendingCount, 0, 'and it consumes the pending sweep rather than duplicating it');
});

test('a non-markdown document arms no timer and publishes nothing', (t) => {
  const { wiring, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(SCRIPT_URI, 'javascript', 'const the the = 1;\n'));
  lsp('textDocument/didChange', didChangeParams(SCRIPT_URI, 2, 'const the the = 2;\n'));
  assert.equal(timers.pendingCount, 0);

  timers.runPending();
  lsp('textDocument/didSave', { textDocument: { uri: SCRIPT_URI } });
  assert.deepEqual(sent, [], 'v1 sweeps markdown only');
});

test('didClose drops the document and its pending sweep', (t) => {
  const { wiring, connection, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  assert.equal(connection.docCount, 0);
  assert.equal(timers.pendingCount, 0);

  timers.runPending();
  assert.deepEqual(sent, []);
});

test('closing a connection clears its store, its timers, and the wiring roster', (t) => {
  const { wiring, connection, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  assert.equal(wiring.connectionCount, 1);

  connection.close();
  assert.equal(connection.isClosed, true);
  assert.equal(connection.docCount, 0);
  assert.equal(connection.pendingSweepCount, 0);
  assert.equal(timers.pendingCount, 0);
  assert.equal(wiring.connectionCount, 0);

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  assert.deepEqual(sent, [], 'a closed connection accepts nothing further');
});

test('malformed frames are dropped with a log line, never a throw', (t) => {
  const { wiring, connection, warnings, sent, timers, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  connection.handleFrame('not json at all');
  connection.handleFrame(JSON.stringify(['an', 'array']));
  connection.handleFrame(JSON.stringify({ type: 'something-else', method: 'textDocument/didOpen' }));
  connection.handleFrame(JSON.stringify({ type: 'lsp' }));
  connection.handleFrame(JSON.stringify({ type: 'lsp', method: 'textDocument/didChange', params: { textDocument: { uri: 'file:///never-opened.md', version: 2 } } }));
  assert.equal(warnings.length, 5, 'every drop is logged');
  assert.deepEqual(sent, []);

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  assert.equal(sent.length, 1, 'the connection still works afterwards');
});

// --- Tab feed: the control-WS broadcast and the connect-time snapshot ---

test('a sweep that publishes also broadcasts the findings for that uri', (t) => {
  const { wiring, timers, broadcasts, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  assert.deepEqual(broadcasts, [], 'nothing before the quiet window');

  timers.runPending();
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(Object.keys(broadcasts[0]).sort(), ['diagnostics', 'ts', 'type', 'uri']);
  assert.equal(broadcasts[0].type, 'visions-findings');
  assert.equal(broadcasts[0].uri, MARKDOWN_URI);
  assert.equal(broadcasts[0].ts, FIXED_TS, 'the ts comes from the injected clock');
  assert.deepEqual(broadcasts[0].diagnostics, sent[0].params.diagnostics, 'the tab sees what the editor sees');
});

test('an edit that fixes the last finding broadcasts an empty array and drops the uri', (t) => {
  const { wiring, timers, broadcasts, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  assert.equal(findingSections(wiring).length, 1);

  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, CLEAN_MARKDOWN));
  timers.runPending();
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(broadcasts[1], {
    type: 'visions-findings', uri: MARKDOWN_URI, diagnostics: [], ts: FIXED_TS,
  });
  assert.deepEqual(findingSections(wiring), [], 'a uri with no findings is absent, never stored empty');
});

test('didClose clears the uri and tells the tab to forget its section', (t) => {
  const { wiring, timers, broadcasts, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();

  lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(broadcasts[1], {
    type: 'visions-findings', uri: MARKDOWN_URI, diagnostics: [], ts: FIXED_TS,
  });
  assert.deepEqual(findingSections(wiring), []);
});

test('closing a document that never had findings says nothing at all', (t) => {
  const { wiring, timers, broadcasts, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  timers.runPending();
  const afterSweep = broadcasts.length;

  lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  assert.equal(broadcasts.length, afterSweep, 'no section existed, so there is nothing to clear');
});

test('the snapshot accessor carries every uri that currently has findings', (t) => {
  const { wiring, timers, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  const otherUri = 'file:///tmp/other.markdown';
  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didOpen', didOpenParams(otherUri, 'markdown', CLEAN_MARKDOWN));
  lsp('textDocument/didOpen', didOpenParams(SCRIPT_URI, 'javascript', 'const the the = 1;\n'));
  timers.runPending();

  const snapshot = findingSections(wiring);
  assert.deepEqual(snapshot.map((entry) => entry.uri), [MARKDOWN_URI], 'clean and non-markdown documents earn no entry');
  assert.deepEqual(snapshot[0].diagnostics.map((d) => d.code), ['repeated-word']);

  const message = wiring.snapshotMessage();
  assert.equal(message.type, 'visions-snapshot');
  assert.equal(message.ts, FIXED_TS);
  assert.deepEqual(message.documents, wiring.documentsSnapshot());
  assert.deepEqual(
    message.documents,
    [{ uri: MARKDOWN_URI, diagnostics: snapshot[0].diagnostics, comments: [], hand: null }],
    'the comments and hand fields are additive: present and empty when tier 3 has said nothing',
  );
});

// The relay replays its open buffers on reconnect (docs/archive/plan-navigator.md, M1), so a dropped socket is a
// gap in the feed, not news that the carbon unit closed anything.
test('a relay disconnect keeps the findings the tab is showing', (t) => {
  const { wiring, connection, timers, broadcasts, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  const afterSweep = broadcasts.length;

  connection.close();
  assert.equal(connection.docCount, 0, 'the mirrored buffer is gone with the socket');
  assert.equal(broadcasts.length, afterSweep, 'but the tab is told nothing');
  assert.deepEqual(findingSections(wiring).map((entry) => entry.uri), [MARKDOWN_URI]);
});

test('a lane with no broadcast injected still sweeps and still tracks findings', (t) => {
  const timers = fakeTimers();
  const sent = [];
  const wiring = createVisionsWiring({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: { warn: () => {} },
  });
  t.after(() => wiring.stop());
  const connection = wiring.openConnection({ send: (message) => sent.push(message) });

  connection.handleFrame(JSON.stringify({
    type: 'lsp', method: 'textDocument/didOpen', params: didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN),
  }));
  timers.runPending();
  assert.equal(sent.length, 1);
  assert.deepEqual(findingSections(wiring).map((entry) => entry.uri), [MARKDOWN_URI]);
});

// --- Tier 3 model dispatch (docs/archive/plan-navigator.md, M4), spawner injected ---

const COMMENT = { line: 3, message: 'The repeat is a symptom; the sentence is doing two jobs.' };
const MODEL_DIAGNOSTIC = { line: 1, message: 'The title is missing a concrete noun.' };

/**
 * A lane whose dispatch is a fake: it records what it was asked and answers whatever the test says.
 * NOTHING here spawns claude; the real spawn is covered by tests/visions-dispatch.test.js.
 */
function dispatchingConnection({
  dispatch: overrides = {}, respond = null, contextDigest = null, contextSeq = null, scopeProjects = null, debug = false,
} = {}) {
  const calls = [];
  const dispatchConfig = { enabled: true, ...overrides };
  const dispatch = (args) => {
    calls.push(args);
    if (typeof respond === 'function') return respond(args, calls.length);
    return Promise.resolve({ verdict: 'NONE', comments: [], reason: null });
  };
  return {
    ...drivenConnection({
      dispatchConfig, dispatch, contextDigest, contextSeq, scopeProjects, debug,
    }),
    calls,
  };
}

// The publish arms the quiet window, so a lane driven by the fake timers needs two rounds: one for the
// sweep, one for the dispatch that sweep armed.
function runSweepThenDispatch(timers) {
  timers.runPending();
  timers.runPending();
}

test('a dispatch fires one quiet window after a sweep publishes, carrying the buffer and its findings', async (t) => {
  const { wiring, timers, calls, lsp } = dispatchingConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  assert.equal(calls.length, 0, 'the publish is not the dispatch');
  assert.equal(timers.pendingCount, 1, 'it armed the quiet window instead');

  timers.runPending();
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].uri, MARKDOWN_URI);
  assert.equal(calls[0].text, REPEATED_WORD_MARKDOWN);
  assert.deepEqual(calls[0].findings.map((finding) => finding.code), ['repeated-word'], 'tier 2 rides along');
});

test('a scoped visions skips sweep and refuses dispatch for an out-of-scope document', async (t) => {
  const uri = 'file:///other/plan-visions.md';
  const { wiring, timers, sent, calls, notes, lsp } = dispatchingConnection({ scopeProjects: [{ id: PROJECT_ID, path: '/tmp/project' }] });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(uri, 'markdown', '# Title\n\nOutside'));
  assert.equal(timers.pendingCount, 0, 'out-of-scope open does not arm a sweep');
  assert.equal(sent.length, 0, 'out-of-scope open publishes nothing');

  lsp('textDocument/didChange', rangedChangeParams(uri, 2, [
    { range: { start: { line: 2, character: 7 }, end: { line: 2, character: 7 } }, text: '\n' },
  ]));
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 0, 'out-of-scope dispatch does not call the model');
  assert.ok(notes.some((line) => line.includes('out-of-scope')));
  assert.deepEqual(findingSections(wiring), []);
});

test('a scoped visions sweeps and dispatches an in-scope document normally', async (t) => {
  const { wiring, timers, sent, calls, lsp } = dispatchingConnection({ scopeProjects: [{ id: PROJECT_ID, path: '/tmp' }] });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  assert.equal(timers.pendingCount, 1);

  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(sent.filter((message) => message.type === 'publishDiagnostics').length, 1);
  assert.equal(calls.length, 1);
});

test('an edit restarts the quiet window rather than letting the armed one run out', async (t) => {
  const { wiring, connection, timers, calls, lsp } = dispatchingConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  const armed = timers.pendingIds[0];

  const edited = '# Title\n\nA line with with a repeat, still.\n';
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, edited));
  assert.equal(connection.pendingDispatchCount, 1, 'still exactly one window');
  assert.equal(timers.pendingIds.includes(armed), false, 'and it is a NEW one, so the carbon unit is not interrupted mid-flow');

  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, edited, 'the dispatch reads the buffer as it stands when the window expires');
});

test('a save evaluates the same gate at once instead of waiting out the quiet window', async (t) => {
  const { wiring, calls, lsp } = dispatchingConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1, 'a save IS the pause boundary');
});

test('a blank-line didChange evaluates the dispatch gate without waiting out the quiet window', async (t) => {
  const { wiring, timers, calls, lsp } = dispatchingConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', '# Title\n\nA thought'));
  lsp('textDocument/didChange', rangedChangeParams(MARKDOWN_URI, 2, [
    { range: { start: { line: 2, character: 9 }, end: { line: 2, character: 9 } }, text: '\n' },
  ]));
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1, 'the typed blank line is the pause boundary');
  assert.equal(timers.pendingCount, 1, 'the normal sweep still waits out its debounce');
});

test('a blank-line didChange still obeys dispatch gates', async (t) => {
  const { wiring, calls, notes, lsp } = dispatchingConnection({ dispatch: { cooldownMs: 300000 } });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', '# Title\n\nA thought'));
  lsp('textDocument/didChange', rangedChangeParams(MARKDOWN_URI, 2, [
    { range: { start: { line: 2, character: 9 }, end: { line: 2, character: 9 } }, text: '\n' },
  ]));
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1);

  lsp('textDocument/didChange', rangedChangeParams(MARKDOWN_URI, 3, [
    { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } }, text: '\n' },
  ]));
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1, 'cooldown still wins');
  assert.ok(notes.some((line) => line.includes('cooldown')));
});

test('a non-boundary didChange only arms the normal quiet window', async (t) => {
  const { wiring, timers, calls, lsp } = dispatchingConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, '# Title\n\nA rewritten line with with a repeat.\n'));
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 0, 'no immediate dispatch for ordinary edits');
  assert.equal(timers.pendingCount, 1, 'the quiet window is armed');

  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1);
});

test('a second boundary inside the cooldown is skipped with one line naming the gate', async (t) => {
  const { wiring, timers, calls, notes, lsp, clock } = dispatchingConnection({ dispatch: { cooldownMs: 300000 } });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1);

  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, '# Title\n\nRewritten entirely, and and repeated.\n'));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1, 'the buffer moved, but the document is still cooling down');
  assert.ok(notes.some((line) => line.includes('cooldown')), `expected a cooldown line, saw ${JSON.stringify(notes)}`);

  clock.now += 300000;
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 2, 'once the cooldown is up, the same boundary dispatches');
});

test('an unchanged buffer is never dispatched twice, whatever the boundary', async (t) => {
  const { wiring, timers, calls, notes, lsp, clock } = dispatchingConnection({ dispatch: { cooldownMs: 1 } });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  clock.now += 60000;
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1);
  assert.ok(notes.some((line) => line.includes('unchanged')));
});

test('a boundary reached while a dispatch is in flight is gated, not queued', async (t) => {
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  const { wiring, timers, calls, notes, lsp } = dispatchingConnection({
    dispatch: { cooldownMs: 1 },
    respond: (_args, callNumber) => (callNumber === 1 ? held : Promise.resolve({ verdict: 'NONE', comments: [] })),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  const inFlight = wiring.whenDispatchSettled();
  assert.equal(calls.length, 1);

  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, '# Title\n\nA whole new paragraph while it thinks.\n'));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1, 'concurrency is 1');
  assert.ok(notes.some((line) => line.includes('in-flight')));

  release({ verdict: 'COMMENTS', comments: [COMMENT], reason: null });
  await inFlight;
});

test('the hourly budget is machine-wide: a second document is gated once it is spent', async (t) => {
  const otherUri = 'file:///tmp/other.md';
  const { wiring, timers, calls, notes, lsp } = dispatchingConnection({ dispatch: { cooldownMs: 1, maxPerHour: 1 } });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1);

  lsp('textDocument/didOpen', didOpenParams(otherUri, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1, 'a different document, but the same hour');
  assert.ok(notes.some((line) => line.includes('hour-cap')));
});

test('a COMMENTS result is broadcast for that uri and joins the connect-time snapshot', async (t) => {
  const { wiring, timers, broadcasts, lsp } = dispatchingConnection({
    respond: () => Promise.resolve({ verdict: 'COMMENTS', comments: [COMMENT], reason: null }),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  const comments = broadcasts.filter((message) => message.type === 'visions-comments');
  assert.equal(comments.length, 1);
  assert.deepEqual(comments[0], {
    type: 'visions-comments', uri: MARKDOWN_URI, comments: [COMMENT], ts: FIXED_TS,
  });
  assert.deepEqual(wiring.documentsSnapshot(), [{
    uri: MARKDOWN_URI,
    diagnostics: wiring.documentsSnapshot()[0].diagnostics,
    comments: [COMMENT],
    hand: null,
  }], 'one section carries both halves');
});

test('a dispatch with no model diagnostics leaves the rule-only publish stream unchanged', async (t) => {
  const { wiring, timers, broadcasts, sent, lsp } = dispatchingConnection({
    respond: () => Promise.resolve({ verdict: 'NONE', comments: [], reason: null }),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  assert.equal(sent.filter((message) => message.type === 'publishDiagnostics').length, 1);
  assert.equal(broadcasts.filter((message) => message.type === 'visions-findings').length, 1);
  assert.deepEqual(wiring.documentsSnapshot()[0].diagnostics.map((diagnostic) => diagnostic.code), ['repeated-word']);
});

test('model diagnostics publish and broadcast as a union after rule diagnostics', async (t) => {
  const { wiring, timers, broadcasts, sent, lsp } = dispatchingConnection({
    respond: () => Promise.resolve({
      verdict: 'NONE', comments: [], diagnostics: [{ ...MODEL_DIAGNOSTIC, severity: 1 }], reason: null,
    }),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  const published = sent.filter((message) => message.type === 'publishDiagnostics');
  assert.deepEqual(published.at(-1).params.diagnostics.map((diagnostic) => diagnostic.code), ['repeated-word', 'model']);
  assert.equal(published.at(-1).params.diagnostics[1].range.end.character, '# Title'.length);
  assert.equal(published.at(-1).params.diagnostics[1].severity, 4);
  const findings = broadcasts.filter((message) => message.type === 'visions-findings');
  assert.deepEqual(findings.at(-1).diagnostics, published.at(-1).params.diagnostics);
  assert.deepEqual(wiring.documentsSnapshot()[0].diagnostics.map((diagnostic) => diagnostic.code), ['repeated-word', 'model']);
});

test('lint-domain model diagnostics are dropped with a debug count only', async (t) => {
  const { wiring, timers, sent, notes, lsp } = dispatchingConnection({
    debug: () => true,
    respond: () => Promise.resolve({
      verdict: 'NONE',
      comments: [],
      diagnostics: [
        { line: 1, rule: 'no-unused-imports', message: 'Unused import.' },
        { line: 3, message: 'The chosen type of migration conflicts with the rollback plan.' },
      ],
      reason: null,
    }),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  const diagnostics = sent.filter((message) => message.type === 'publishDiagnostics').at(-1).params.diagnostics;
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.message), [
    'Repeated word "with"',
    'The chosen type of migration conflicts with the rollback plan.',
  ]);
  assert.ok(notes.some((line) => line.includes('dropped 1 model diagnostics in the toolchain domain')));
  assert.equal(notes.some((line) => line.includes('Unused import')), false);
});

test('model diagnostics are replaced wholesale by each dispatch', async (t) => {
  let seq = 1;
  const results = [
    { verdict: 'NONE', comments: [], diagnostics: [{ line: 1, message: 'first' }], reason: null },
    { verdict: 'NONE', comments: [], diagnostics: [{ line: 3, message: 'second' }], reason: null },
  ];
  const { wiring, timers, sent, lsp, clock } = dispatchingConnection({
    dispatch: { cooldownMs: 1 },
    contextSeq: () => seq,
    respond: (_args, callNumber) => Promise.resolve(results[callNumber - 1]),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  seq += 1;
  clock.now += 1000;
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();

  const diagnostics = sent.filter((message) => message.type === 'publishDiagnostics').at(-1).params.diagnostics;
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.message), [
    'Repeated word "with"',
    'second',
  ]);
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.code === 'model').length, 1);
});

test('absent model diagnostics clear the standing model diagnostics', async (t) => {
  let seq = 1;
  const results = [
    { verdict: 'NONE', comments: [], diagnostics: [MODEL_DIAGNOSTIC], reason: null },
    { verdict: 'NONE', comments: [], reason: null },
  ];
  const { wiring, timers, sent, lsp, clock } = dispatchingConnection({
    dispatch: { cooldownMs: 1 },
    contextSeq: () => seq,
    respond: (_args, callNumber) => Promise.resolve(results[callNumber - 1]),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  seq += 1;
  clock.now += 1000;
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();

  const diagnostics = sent.filter((message) => message.type === 'publishDiagnostics').at(-1).params.diagnostics;
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), ['repeated-word']);
  assert.deepEqual(wiring.documentsSnapshot()[0].diagnostics.map((diagnostic) => diagnostic.code), ['repeated-word']);
});

test('didChange drops model diagnostics before the next rule-only publish', async (t) => {
  const { wiring, timers, sent, lsp } = dispatchingConnection({
    respond: () => Promise.resolve({ verdict: 'NONE', comments: [], diagnostics: [MODEL_DIAGNOSTIC], reason: null }),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, '# Title\n\nA changed line with with a repeat.\n'));
  timers.runPending();

  const diagnostics = sent.filter((message) => message.type === 'publishDiagnostics').at(-1).params.diagnostics;
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), ['repeated-word']);
});

test('didClose clears standing model diagnostics', async (t) => {
  const { wiring, timers, lsp } = dispatchingConnection({
    respond: () => Promise.resolve({ verdict: 'NONE', comments: [], diagnostics: [MODEL_DIAGNOSTIC], reason: null }),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.deepEqual(wiring.documentsSnapshot()[0].diagnostics.map((diagnostic) => diagnostic.code), ['model']);

  lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  assert.deepEqual(wiring.documentsSnapshot(), []);
});

test('an ERROR verdict leaves standing model diagnostics untouched', async (t) => {
  let seq = 1;
  const results = [
    { verdict: 'NONE', comments: [], diagnostics: [MODEL_DIAGNOSTIC], reason: null },
    { verdict: 'ERROR', comments: [], diagnostics: [], reason: 'no readable result file' },
  ];
  const { wiring, timers, warnings, lsp, clock } = dispatchingConnection({
    dispatch: { cooldownMs: 1 },
    contextSeq: () => seq,
    respond: (_args, callNumber) => Promise.resolve(results[callNumber - 1]),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  seq += 1;
  clock.now += 1000;
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();

  assert.deepEqual(wiring.documentsSnapshot()[0].diagnostics.map((diagnostic) => diagnostic.code), ['model']);
  assert.ok(warnings.some((line) => line.includes('no readable result file')));
});

test('a NONE result clears that document rather than storing an empty section', async (t) => {
  const results = [
    { verdict: 'COMMENTS', comments: [COMMENT], reason: null },
    { verdict: 'NONE', comments: [], reason: null },
  ];
  const { wiring, timers, broadcasts, lsp, clock } = dispatchingConnection({
    dispatch: { cooldownMs: 1 },
    respond: (_args, callNumber) => Promise.resolve(results[callNumber - 1]),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  clock.now += 1000;
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, CLEAN_MARKDOWN));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();

  const comments = broadcasts.filter((message) => message.type === 'visions-comments');
  assert.deepEqual(comments[1].comments, []);
  assert.deepEqual(wiring.documentsSnapshot(), [], 'no findings and no comments means no section at all');
});

test('an ERROR verdict warns and leaves the standing comments exactly as they were', async (t) => {
  const results = [
    { verdict: 'COMMENTS', comments: [COMMENT], reason: null },
    { verdict: 'ERROR', comments: [], reason: 'no readable result file' },
  ];
  const { wiring, timers, broadcasts, warnings, lsp, clock } = dispatchingConnection({
    dispatch: { cooldownMs: 1 },
    respond: (_args, callNumber) => Promise.resolve(results[callNumber - 1]),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  const afterFirst = broadcasts.filter((message) => message.type === 'visions-comments').length;

  clock.now += 1000;
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, '# Title\n\nEdited again, with with a repeat.\n'));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();

  assert.equal(broadcasts.filter((message) => message.type === 'visions-comments').length, afterFirst, 'a failed session says nothing');
  assert.deepEqual(wiring.documentsSnapshot()[0].comments, [COMMENT]);
  assert.ok(warnings.some((line) => line.includes('no readable result file')));
});

test('didClose drops the comments with the findings and tells the tab about both', async (t) => {
  const { wiring, timers, broadcasts, lsp } = dispatchingConnection({
    respond: () => Promise.resolve({ verdict: 'COMMENTS', comments: [COMMENT], reason: null }),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  const last = broadcasts.slice(-2);
  assert.deepEqual(last.map((message) => message.type), ['visions-findings', 'visions-comments']);
  assert.deepEqual(last[1].comments, []);
  assert.deepEqual(wiring.documentsSnapshot(), []);
});

test('a result that lands after its buffer closed is dropped rather than resurrecting a section', async (t) => {
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  const { wiring, timers, broadcasts, lsp } = dispatchingConnection({ respond: () => held });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  const inFlight = wiring.whenDispatchSettled();

  lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  release({ verdict: 'COMMENTS', comments: [COMMENT], reason: null });
  await inFlight;

  assert.deepEqual(wiring.documentsSnapshot(), []);
  assert.equal(broadcasts.filter((message) => message.type === 'visions-comments' && message.comments.length > 0).length, 0);
});

test('a hand is broadcast only when it changes and joins the connect-time snapshot', async (t) => {
  const results = [
    { verdict: 'NONE', comments: [], hand: 'the doc mixes migration plan and incident review', reason: null },
    { verdict: 'NONE', comments: [], hand: 'the doc mixes migration plan and incident review', reason: null },
    { verdict: 'NONE', comments: [], hand: 'the conclusion answers a different question', reason: null },
  ];
  const { wiring, timers, broadcasts, lsp, clock } = dispatchingConnection({
    dispatch: { cooldownMs: 1 },
    respond: (_args, callNumber) => Promise.resolve(results[callNumber - 1]),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  clock.now += 1000;
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, '# Title\n\nA changed line with with a repeat.\n'));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();

  clock.now += 1000;
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 3, '# Title\n\nAnother changed line with with a repeat.\n'));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();

  const hands = broadcasts.filter((message) => message.type === 'visions-hand');
  assert.deepEqual(hands, [
    {
      type: 'visions-hand',
      uri: MARKDOWN_URI,
      hand: 'the doc mixes migration plan and incident review',
      ts: FIXED_TS,
    },
    {
      type: 'visions-hand',
      uri: MARKDOWN_URI,
      hand: 'the conclusion answers a different question',
      ts: FIXED_TS + 2000,
    },
  ]);
  assert.equal(wiring.documentsSnapshot()[0].hand, 'the conclusion answers a different question');
});

test('a handless dispatch clears the standing hand and an ERROR leaves it alone', async (t) => {
  const results = [
    { verdict: 'NONE', comments: [], hand: 'the document has no single reader', reason: null },
    { verdict: 'ERROR', comments: [], reason: 'no readable result file' },
    { verdict: 'NONE', comments: [], reason: null },
  ];
  const { wiring, timers, broadcasts, lsp, clock } = dispatchingConnection({
    dispatch: { cooldownMs: 1 },
    respond: (_args, callNumber) => Promise.resolve(results[callNumber - 1]),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  clock.now += 1000;
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, '# Title\n\nA second line with with a repeat.\n'));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();
  assert.equal(wiring.documentsSnapshot()[0].hand, 'the document has no single reader');

  clock.now += 1000;
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 3, CLEAN_MARKDOWN));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();

  const hands = broadcasts.filter((message) => message.type === 'visions-hand');
  assert.deepEqual(hands.map((message) => message.hand), ['the document has no single reader', null]);
  assert.deepEqual(wiring.documentsSnapshot(), []);
});

test('didClose clears a standing hand', async (t) => {
  const { wiring, timers, broadcasts, lsp } = dispatchingConnection({
    respond: () => Promise.resolve({
      verdict: 'NONE', comments: [], hand: 'the document has two incompatible structures', reason: null,
    }),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  const hand = broadcasts.filter((message) => message.type === 'visions-hand').at(-1);
  assert.deepEqual(hand, {
    type: 'visions-hand', uri: MARKDOWN_URI, hand: null, ts: FIXED_TS,
  });
  assert.deepEqual(wiring.documentsSnapshot(), []);
});

// --- The intent model (docs/archive/plan-navigator.md, M5) ---

function intentBroadcasts(broadcasts) {
  return broadcasts.filter((message) => message.type === 'visions-intent');
}

test('a model proposal is broadcast once and joins the connect-time snapshot', (t) => {
  const { wiring, broadcasts } = drivenConnection();
  t.after(() => wiring.stop());

  assert.equal(wiring.applyModelIntent('reviewing the visions plan, tightening scope'), true);
  assert.deepEqual(intentBroadcasts(broadcasts), [{
    type: 'visions-intent',
    projectId: null,
    intent: {
      text: 'reviewing the visions plan, tightening scope', source: 'model', ts: FIXED_TS,
    },
    ts: FIXED_TS,
  }]);
  assert.deepEqual(wiring.snapshotMessage().intent, {
    global: { text: 'reviewing the visions plan, tightening scope', source: 'model', ts: FIXED_TS },
    byProject: {},
  });
});

test('a proposal for one project names it on the wire and leaves the others alone', (t) => {
  const { wiring, broadcasts } = drivenConnection();
  t.after(() => wiring.stop());

  assert.equal(wiring.applyModelIntent('the machine-wide belief'), true);
  assert.equal(wiring.applyModelIntent('what this repo is for', PROJECT_ID), true);

  assert.deepEqual(intentBroadcasts(broadcasts).at(-1), {
    type: 'visions-intent',
    projectId: PROJECT_ID,
    intent: {
      text: 'what this repo is for', source: 'model', ts: FIXED_TS,
    },
    ts: FIXED_TS,
  });
  assert.deepEqual(wiring.snapshotMessage().intent, {
    global: { text: 'the machine-wide belief', source: 'model', ts: FIXED_TS },
    byProject: { [PROJECT_ID]: { text: 'what this repo is for', source: 'model', ts: FIXED_TS } },
  });
  assert.equal(wiring.getIntentFor(OTHER_PROJECT_ID).text, '', 'another project is untouched by it');
});

test('a proposal that changes nothing is not broadcast', (t) => {
  const { wiring, broadcasts } = drivenConnection();
  t.after(() => wiring.stop());

  wiring.applyModelIntent('one belief');
  assert.equal(wiring.applyModelIntent('one belief'), false);
  assert.equal(wiring.applyModelIntent(''), false, 'a model with nothing to say says nothing');
  assert.equal(intentBroadcasts(broadcasts).length, 1);
});

test('a later model proposal replaces the standing statement', (t) => {
  const { wiring, broadcasts } = drivenConnection();
  t.after(() => wiring.stop());

  wiring.applyModelIntent('rewriting the merge gate, not the spawn path');
  assert.deepEqual(wiring.getIntentFor(), {
    text: 'rewriting the merge gate, not the spawn path', source: 'model', ts: FIXED_TS,
  });

  assert.equal(wiring.applyModelIntent('a plan doc about spawning'), true);
  assert.equal(intentBroadcasts(broadcasts).length, 2);
  assert.equal(wiring.getIntentFor().text, 'a plan doc about spawning');
});

test('an empty lane still carries an intent field on its snapshot', (t) => {
  const { wiring } = drivenConnection();
  t.after(() => wiring.stop());
  assert.deepEqual(wiring.snapshotMessage().intent, { global: null, byProject: {} });
});

test('model intent persists on change only and revives on the next wiring', async (t) => {
  const intentStatePath = tempIntentStatePath(t);
  const counted = countingFsPromises();
  const { wiring } = drivenConnection({ intentStatePath, fsPromises: counted.fsPromises });
  t.after(() => wiring.stop());

  assert.equal(wiring.applyModelIntent('  durable belief  '), true);
  assert.equal(wiring.applyModelIntent('a belief about one repo', PROJECT_ID), true);
  await wiring.whenIntentPersistenceIdle();
  assert.equal(counted.writes.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(intentStatePath, 'utf8')), {
    global: { text: 'durable belief', source: 'model', ts: FIXED_TS },
    byProject: { [PROJECT_ID]: { text: 'a belief about one repo', source: 'model', ts: FIXED_TS } },
  });

  assert.equal(wiring.applyModelIntent('durable belief'), false);
  await wiring.whenIntentPersistenceIdle();
  assert.equal(counted.writes.length, 2);

  const revived = drivenConnection({ intentStatePath });
  t.after(() => revived.wiring.stop());
  assert.deepEqual(revived.wiring.getIntentFor(), {
    text: 'durable belief', source: 'model', ts: FIXED_TS,
  });
  assert.deepEqual(revived.wiring.getIntentFor(PROJECT_ID), {
    text: 'a belief about one repo', source: 'model', ts: FIXED_TS,
  });
});

test('a project the config no longer knows loses its slot on the next load', async (t) => {
  const intentStatePath = tempIntentStatePath(t);
  fs.writeFileSync(intentStatePath, JSON.stringify({
    global: { text: 'the global belief', source: 'model', ts: FIXED_TS },
    byProject: {
      [PROJECT_ID]: { text: 'still configured', source: 'model', ts: FIXED_TS },
      [OTHER_PROJECT_ID]: { text: 'deleted project', source: 'model', ts: FIXED_TS },
    },
  }), 'utf8');

  const { wiring, warnings } = drivenConnection({ intentStatePath, knownProjectIds: [PROJECT_ID] });
  t.after(() => wiring.stop());

  assert.deepEqual(wiring.getIntent(), {
    global: { text: 'the global belief', source: 'model', ts: FIXED_TS },
    byProject: { [PROJECT_ID]: { text: 'still configured', source: 'model', ts: FIXED_TS } },
  });
  assert.deepEqual(warnings, [], 'a deleted project is routine, not a corrupt file');
});

test('a legacy locked intent file revives with model ownership', async (t) => {
  const intentStatePath = tempIntentStatePath(t);
  fs.writeFileSync(intentStatePath, JSON.stringify({
    text: 'durable correction', source: 'operator', locked: true, ts: FIXED_TS,
  }), 'utf8');
  const counted = countingFsPromises();
  const { wiring } = drivenConnection({ intentStatePath, fsPromises: counted.fsPromises });
  t.after(() => wiring.stop());

  assert.deepEqual(wiring.getIntentFor(), {
    text: 'durable correction', source: 'model', ts: FIXED_TS,
  });
  assert.equal(wiring.applyModelIntent('durable model belief'), true);
  assert.deepEqual(wiring.getIntentFor(), {
    text: 'durable model belief', source: 'model', ts: FIXED_TS,
  });

  // The next persist writes the per-project shape, so the flat file is read once and never rewritten.
  await wiring.whenIntentPersistenceIdle();
  assert.deepEqual(JSON.parse(fs.readFileSync(intentStatePath, 'utf8')), {
    global: { text: 'durable model belief', source: 'model', ts: FIXED_TS },
    byProject: {},
  });
});

test('a model intent persists without a locked field', async (t) => {
  const intentStatePath = tempIntentStatePath(t);
  const counted = countingFsPromises();
  const { wiring } = drivenConnection({ intentStatePath, fsPromises: counted.fsPromises });
  t.after(() => wiring.stop());

  assert.equal(wiring.applyModelIntent('durable model belief'), true);
  await wiring.whenIntentPersistenceIdle();
  assert.equal(counted.writes.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(intentStatePath, 'utf8')), {
    global: { text: 'durable model belief', source: 'model', ts: FIXED_TS },
    byProject: {},
  });
});

test('a legacy flat empty intent file is not a corrupt one', (t) => {
  const intentStatePath = tempIntentStatePath(t);
  fs.writeFileSync(intentStatePath, JSON.stringify({ text: '', source: null, ts: 0 }), 'utf8');

  const { wiring, warnings } = drivenConnection({ intentStatePath });
  t.after(() => wiring.stop());

  assert.deepEqual(wiring.getIntent(), { global: null, byProject: {} });
  assert.deepEqual(warnings, [], 'a file that only ever said nothing says nothing on every boot');
});

test('a corrupt intent file starts empty and warns once', (t) => {
  const intentStatePath = tempIntentStatePath(t);
  fs.writeFileSync(intentStatePath, '{', 'utf8');

  const { wiring, warnings } = drivenConnection({ intentStatePath });
  t.after(() => wiring.stop());

  assert.deepEqual(wiring.getIntent(), { global: null, byProject: {} });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /intent state unreadable, starting empty/);
});

test('without an intent path the lane keeps the same in-memory behavior and touches no storage', async (t) => {
  const fsFns = { readFileSync: () => { throw new Error('must not read'); } };
  const fsPromises = {
    mkdir: () => Promise.reject(new Error('must not write')),
    writeFile: () => Promise.reject(new Error('must not write')),
    rename: () => Promise.reject(new Error('must not write')),
    rm: () => Promise.reject(new Error('must not write')),
  };
  const { wiring, broadcasts, warnings } = drivenConnection({ fsFns, fsPromises });
  t.after(() => wiring.stop());

  assert.deepEqual(wiring.snapshotMessage().intent, { global: null, byProject: {} });
  assert.equal(wiring.applyModelIntent('memory only'), true);
  await wiring.whenIntentPersistenceIdle();
  assert.deepEqual(intentBroadcasts(broadcasts), [{
    type: 'visions-intent',
    projectId: null,
    intent: {
      text: 'memory only', source: 'model', ts: FIXED_TS,
    },
    ts: FIXED_TS,
  }]);
  assert.deepEqual(warnings, []);
});

test('the standing intent rides the dispatch, and the result updates it after the comments', async (t) => {
  const { wiring, timers, calls, broadcasts, lsp } = dispatchingConnection({
    respond: () => Promise.resolve({
      verdict: 'COMMENTS', comments: [COMMENT], intent: 'a plan doc for the visions intent model', reason: null,
    }),
  });
  t.after(() => wiring.stop());

  wiring.applyModelIntent('an early guess');
  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  assert.equal(calls[0].intent, 'an early guess', 'the prompt is built from what the lane currently believes');
  assert.equal(wiring.getIntentFor().text, 'a plan doc for the visions intent model');
  const order = broadcasts.filter((message) => ['visions-comments', 'visions-intent'].includes(message.type));
  assert.deepEqual(order.map((message) => message.type), ['visions-intent', 'visions-comments', 'visions-intent'],
    'the dispatch result lands comments first, then the belief it came with');
});

test('a dispatch intent result replaces the standing intent', async (t) => {
  const { wiring, timers, calls, broadcasts, lsp } = dispatchingConnection({
    respond: () => Promise.resolve({
      verdict: 'NONE', comments: [], intent: 'what the model would rather believe', reason: null,
    }),
  });
  t.after(() => wiring.stop());

  wiring.applyModelIntent('what I am actually doing');
  const beforeDispatch = intentBroadcasts(broadcasts).length;

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  assert.equal(calls[0].intent, 'what I am actually doing');
  assert.deepEqual(wiring.getIntentFor(), {
    text: 'what the model would rather believe', source: 'model', ts: FIXED_TS,
  });
  assert.equal(intentBroadcasts(broadcasts).length, beforeDispatch + 1);
});

test('a dispatch on an owned uri reads and writes that project slot, falling back to global for the prompt', async (t) => {
  const { wiring, timers, calls, broadcasts, lsp } = dispatchingConnection({
    scopeProjects: [{ id: PROJECT_ID, path: '/tmp' }],
    respond: () => Promise.resolve({
      verdict: 'NONE', comments: [], intent: 'what this project is really for', reason: null,
    }),
  });
  t.after(() => wiring.stop());

  wiring.applyModelIntent('the machine-wide belief');
  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  assert.equal(calls[0].intent, 'the machine-wide belief', 'a project with no statement reads the global one');
  assert.equal(wiring.getIntentFor(PROJECT_ID).text, 'what this project is really for');
  assert.equal(wiring.getIntentFor().text, 'the machine-wide belief', 'the global slot is not overwritten by it');
  assert.equal(intentBroadcasts(broadcasts).at(-1).projectId, PROJECT_ID);
});

test('a second dispatch on the same project reads the project statement, not the global one', async (t) => {
  const { wiring, timers, calls, lsp, clock } = dispatchingConnection({
    scopeProjects: [{ id: PROJECT_ID, path: '/tmp' }],
    dispatch: { cooldownMs: 1 },
    respond: (_args, count) => Promise.resolve({
      verdict: 'NONE', comments: [], intent: count === 1 ? 'what this project is really for' : null, reason: null,
    }),
  });
  t.after(() => wiring.stop());

  wiring.applyModelIntent('the machine-wide belief');
  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  clock.now += 60000;
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, `${REPEATED_WORD_MARKDOWN}\nmore\n`));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].intent, 'what this project is really for');
});

test('a result with no intent field leaves the statement exactly as it was', async (t) => {
  const { wiring, timers, lsp } = dispatchingConnection({
    respond: () => Promise.resolve({ verdict: 'NONE', comments: [], reason: null }),
  });
  t.after(() => wiring.stop());

  wiring.applyModelIntent('still the current belief');
  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  assert.equal(wiring.getIntentFor().text, 'still the current belief');
});

// The M3 lane, byte for byte: an absent config.visions.dispatch must cost nothing at all.
test('with no dispatch config the lane arms no dispatch timer and calls nothing', async (t) => {
  const calls = [];
  const { wiring, connection, timers, lsp } = drivenConnection({
    dispatch: (args) => { calls.push(args); return Promise.resolve({ verdict: 'NONE', comments: [] }); },
  });
  t.after(() => wiring.stop());
  assert.equal(wiring.dispatchEnabled, false);

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  assert.equal(connection.pendingDispatchCount, 0);
  assert.equal(timers.pendingCount, 0, 'the publish armed nothing');

  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();
  assert.deepEqual(calls, [], 'no boundary can reach a lane that was never given a dispatch config');
  assert.deepEqual(wiring.documentsSnapshot()[0].comments, []);
});

test('a dispatch config that is present but not enabled is just as inert', () => {
  const wiring = createVisionsWiring({
    logger: { warn: () => {} },
    dispatchConfig: { enabled: false, quietMs: 10 },
    dispatch: () => Promise.resolve({ verdict: 'COMMENTS', comments: [COMMENT] }),
  });
  assert.equal(wiring.dispatchEnabled, false);
  wiring.stop();
});

// --- Tier 1 silent fixes (docs/archive/plan-navigator-2.md, M6) ---

const TWO_REPEATS_AND_A_FENCE = '# Title\n\nA line with with a repeat.\n\nAnd a a second one.\n\n```js\nconst answer = 42;\n';

function sendRequest(connection, id, method, params) {
  connection.handleFrame(JSON.stringify({
    type: 'lsp-request', id, method, params,
  }));
}

function answerRequest(connection, id, result) {
  connection.handleFrame(JSON.stringify({ type: 'lsp-response', id, result }));
}

function requestCodeActions(harness, { id = 'ca-1', uri = MARKDOWN_URI, range = null } = {}) {
  sendRequest(harness.connection, id, 'textDocument/codeAction', { textDocument: { uri }, range });
  const answer = harness.sent.filter((message) => message.type === 'lsp-response' && message.id === id).pop();
  return answer ? answer.result : undefined;
}

function applyEditRequests(harness) {
  return harness.sent.filter((message) => message.type === 'lsp-request' && message.method === 'workspace/applyEdit');
}

function fixBroadcasts(harness) {
  return harness.broadcasts.filter((message) => message.type === 'visions-fix');
}

test('a code action is answered from what the last sweep computed, never from a fresh sweep', (t) => {
  const harness = drivenConnection();
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  harness.timers.runPending();

  const actions = requestCodeActions(harness);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'quickfix');
  assert.equal(actions[0].diagnostics[0].code, 'repeated-word');
  assert.deepEqual(actions[0].edit.documentChanges[0].textDocument, { uri: MARKDOWN_URI, version: 1 });
});

test('each sweep replaces the stored fixes, so a corrected buffer offers nothing', (t) => {
  const harness = drivenConnection();
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  harness.timers.runPending();
  assert.equal(requestCodeActions(harness, { id: 'ca-before' }).length, 1);

  harness.lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, CLEAN_MARKDOWN));
  harness.timers.runPending();
  assert.deepEqual(requestCodeActions(harness, { id: 'ca-after' }), []);
});

test('a selection is answered with the fixes it touches and nothing else', (t) => {
  const harness = drivenConnection();
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', TWO_REPEATS_AND_A_FENCE));
  harness.timers.runPending();

  assert.equal(requestCodeActions(harness, { id: 'ca-all' }).length, 3, 'the whole document offers every fix');
  const onLineFour = requestCodeActions(harness, {
    id: 'ca-line-4', range: { start: { line: 4, character: 0 }, end: { line: 4, character: 18 } },
  });
  assert.deepEqual(onLineFour.map((action) => action.diagnostics[0].code), ['repeated-word']);
  assert.equal(onLineFour[0].diagnostics[0].range.start.line, 4);
});

test('a fix set is never served against text the buffer has already moved on from', (t) => {
  const harness = drivenConnection();
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  harness.timers.runPending();
  assert.equal(requestCodeActions(harness, { id: 'ca-fresh' }).length, 1);

  // The keystroke landed; its sweep has not run yet, so the stored set describes text that is gone.
  harness.lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, `${REPEATED_WORD_MARKDOWN}More.\n`));
  assert.deepEqual(requestCodeActions(harness, { id: 'ca-stale' }), []);
});

test('a code action for a document the lane never mirrored is empty rather than an error', (t) => {
  const harness = drivenConnection();
  t.after(() => harness.wiring.stop());

  assert.deepEqual(requestCodeActions(harness, { id: 'ca-unknown', uri: 'file:///tmp/never-opened.md' }), []);
});

test('an unknown request method is answered null, never dropped for the relay to time out on', (t) => {
  const harness = drivenConnection();
  t.after(() => harness.wiring.stop());

  sendRequest(harness.connection, 'req-9', 'textDocument/formatting', {});
  assert.deepEqual(harness.sent, [{ type: 'lsp-response', id: 'req-9', result: null }]);
  assert.deepEqual(harness.warnings, []);
});

test('a request frame with no id is refused as malformed rather than answered into the void', (t) => {
  const harness = drivenConnection();
  t.after(() => harness.wiring.stop());

  harness.connection.handleFrame(JSON.stringify({ type: 'lsp-request', method: 'textDocument/codeAction' }));
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.warnings.length, 1);
  assert.match(harness.warnings[0], /missing id/);
});

test('with autoFix off a sweep offers its fixes and asks for nothing', (t) => {
  const harness = drivenConnection();
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', TWO_REPEATS_AND_A_FENCE));
  harness.timers.runPending();

  assert.deepEqual(applyEditRequests(harness), []);
  assert.deepEqual(fixBroadcasts(harness), []);
  assert.equal(requestCodeActions(harness, { id: 'ca-off' }).length, 3);
});

test('with autoFix on one sweep asks for one versioned edit carrying only the auto-safe fixes', (t) => {
  const harness = drivenConnection({ autoFix: true });
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', TWO_REPEATS_AND_A_FENCE));
  harness.timers.runPending();

  const requests = applyEditRequests(harness);
  assert.equal(requests.length, 1, 'one request per sweep, not one per fix');
  const [change] = requests[0].params.edit.documentChanges;
  assert.deepEqual(change.textDocument, { uri: MARKDOWN_URI, version: 1 }, 'versioned, so a racing keystroke refuses it');
  assert.equal(change.edits.length, 2, 'both repeated words, and never the fence guess');
  assert.deepEqual(change.edits.map((edit) => edit.newText), ['', '']);
  assert.equal(requests[0].params.label, 'Visions: 2 silent fixes');
});

test('an applied edit is logged and broadcast once per fix, and joins the snapshot', (t) => {
  const harness = drivenConnection({ autoFix: true });
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', TWO_REPEATS_AND_A_FENCE));
  harness.timers.runPending();
  answerRequest(harness.connection, applyEditRequests(harness)[0].id, { applied: true });

  const broadcasts = fixBroadcasts(harness);
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(broadcasts[0], {
    type: 'visions-fix',
    uri: MARKDOWN_URI,
    fix: {
      code: 'repeated-word', line: 2, message: 'Repeated word "with"', applied: true,
    },
    ts: FIXED_TS,
  });

  const { fixes } = harness.wiring.snapshotMessage();
  assert.equal(fixes.length, 2);
  assert.equal(fixes[0].line, 4, 'newest first');
  assert.deepEqual(fixes.map((entry) => entry.applied), [true, true]);
  assert.equal(fixes[0].uri, MARKDOWN_URI);
});

test('a refused edit is logged exactly as loudly and is never retried', (t) => {
  const harness = drivenConnection({ autoFix: true });
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  harness.timers.runPending();
  answerRequest(harness.connection, applyEditRequests(harness)[0].id, { applied: false });

  assert.deepEqual(fixBroadcasts(harness).map((message) => message.fix.applied), [false]);
  assert.equal(harness.wiring.snapshotMessage().fixes[0].applied, false);
  assert.equal(applyEditRequests(harness).length, 1, 'the refusal buys no second attempt');
  assert.equal(requestCodeActions(harness, { id: 'ca-after-refusal' }).length, 1, 'and the fix stays on offer');
});

test('an editor that never answers is logged as a refusal once the wait is up', (t) => {
  const harness = drivenConnection({ autoFix: true });
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  harness.timers.runPending();
  assert.deepEqual(fixBroadcasts(harness), [], 'nothing is logged while the editor is still deciding');

  harness.timers.runPending();
  assert.deepEqual(fixBroadcasts(harness).map((message) => message.fix.applied), [false]);
  assert.match(harness.notes.join('\n'), /auto-fix refused/);
});

test('an answer for an id the lane never asked about changes nothing', (t) => {
  const harness = drivenConnection({ autoFix: true });
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  harness.timers.runPending();
  answerRequest(harness.connection, 'visions-fix-999', { applied: true });

  assert.deepEqual(fixBroadcasts(harness), []);
  assert.deepEqual(harness.wiring.snapshotMessage().fixes, []);
});

test('the changelog is capped, so an unattended lane cannot grow it without end', (t) => {
  const harness = drivenConnection({ autoFix: true });
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  harness.timers.runPending();
  answerRequest(harness.connection, applyEditRequests(harness)[0].id, { applied: true });

  for (let round = 0; round < 25; round++) {
    harness.lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, round + 2, `A line with with repeat ${round}.\n`));
    harness.timers.runPending();
    answerRequest(harness.connection, applyEditRequests(harness).pop().id, { applied: true });
  }

  const { fixes } = harness.wiring.snapshotMessage();
  assert.equal(fixes.length, 20);
  assert.equal(fixes[0].message, 'Repeated word "with"');
});

test('didClose drops the stored fixes and settles the edit the buffer will never answer', (t) => {
  const harness = drivenConnection({ autoFix: true });
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  harness.timers.runPending();
  harness.lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });

  assert.deepEqual(fixBroadcasts(harness).map((message) => message.fix.applied), [false]);
  assert.deepEqual(requestCodeActions(harness, { id: 'ca-closed' }), []);
});

test('a relay that drops mid-edit settles it rather than owing the changelog a line forever', (t) => {
  const harness = drivenConnection({ autoFix: true });
  t.after(() => harness.wiring.stop());

  harness.lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  harness.timers.runPending();
  harness.connection.close();

  assert.deepEqual(fixBroadcasts(harness).map((message) => message.fix.applied), [false]);
  assert.match(harness.notes.join('\n'), /the relay disconnected/);
});

test('an empty lane still carries a fixes field on its snapshot', (t) => {
  const harness = drivenConnection();
  t.after(() => harness.wiring.stop());
  assert.deepEqual(harness.wiring.snapshotMessage().fixes, []);
});

// --- Real backend boots ---

const booted = [];

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function bootBackend(configPatch, { remotePort = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-visions-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [], teams: [], repoRoots: [], ...configPatch }, null, 2), 'utf8');
  const previousEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;

  const entry = { dir, backend: null, server: http.createServer(), remoteServer: null, port: null, remotePort };
  try {
    entry.backend = createBackend(entry.server, { staticDir: null });
  } finally {
    if (previousEnv == null) delete process.env.GLISSA_CONFIG;
    if (previousEnv != null) process.env.GLISSA_CONFIG = previousEnv;
  }
  booted.push(entry);
  entry.server.on('request', entry.backend.app);
  await new Promise((resolve) => entry.server.listen(0, '127.0.0.1', resolve));
  entry.port = entry.server.address().port;

  if (remotePort) {
    entry.remoteServer = http.createServer();
    entry.backend.remote.attach(entry.remoteServer);
    await new Promise((resolve) => entry.remoteServer.listen(remotePort, '127.0.0.1', resolve));
  }
  return entry;
}

test.after(async () => {
  for (const entry of booted) {
    entry.backend.shutdown();
    for (const server of [entry.server, entry.remoteServer]) {
      if (!server) continue;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
});

function visionsClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/visions`);
  const frames = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  const opened = new Promise((resolve, reject) => {
    ws.on('open', () => resolve('open'));
    ws.on('error', reject);
  });
  return {
    ws,
    frames,
    opened,
    sendRaw: (raw) => ws.send(raw),
    sendLsp: (method, params) => ws.send(JSON.stringify({ type: 'lsp', method, params })),
    close: () => ws.close(),
  };
}

async function waitForDiagnostics(client, uri, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = client.frames.find((msg) => msg.type === 'publishDiagnostics'
      && msg.params.uri === uri
      && msg.params.diagnostics.length > 0);
    if (frame) return frame;
    await delay(25);
  }
  return null;
}

/**
 * Asks the SERVER what it did with a socket rather than inferring it from the client side (the trick
 * tests/backend-remote-enabled.test.js uses): a second 'upgrade' listener runs right after the
 * backend's, so socket.destroyed says whether the backend closed it or left it for another listener.
 * Destroying it here is also what keeps an accepted upgrade from leaking a detached handle.
 */
function backendDestroyedUpgrade(server, port, requestPath) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no upgrade event for ${requestPath}`)), 5000);
    let client = null;
    server.once('upgrade', (_req, socket) => {
      clearTimeout(timer);
      const destroyedByBackend = socket.destroyed;
      socket.destroy();
      if (client) client.destroy();
      resolve(destroyedByBackend);
    });
    client = net.connect(port, '127.0.0.1', () => {
      client.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'));
    });
    client.on('error', () => { /* the server end closing is the expected outcome */ });
  });
}

test('an enabled lane serves /visions on the local listener and publishes markdown diagnostics', async (t) => {
  const { port } = await bootBackend({ visions: { enabled: true } });
  const client = visionsClient(port);
  t.after(() => client.close());
  assert.equal(await client.opened, 'open');

  client.sendLsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  client.sendLsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, REPEATED_WORD_MARKDOWN));

  const frame = await waitForDiagnostics(client, MARKDOWN_URI);
  assert.ok(frame, 'a publishDiagnostics frame arrives on the same socket');
  assert.deepEqual(frame.params.diagnostics.map((d) => d.code), ['repeated-word']);
  assert.equal(frame.params.diagnostics[0].source, 'glissa-visions');
  assert.equal(frame.params.diagnostics[0].range.start.line, 2);
});

test('a non-markdown document over the same socket yields no diagnostics, and a garbage frame kills nothing', async (t) => {
  const { port } = await bootBackend({ visions: { enabled: true } });
  const client = visionsClient(port);
  t.after(() => client.close());
  assert.equal(await client.opened, 'open');

  client.sendRaw('this is not a frame');
  client.sendLsp('textDocument/didOpen', didOpenParams(SCRIPT_URI, 'javascript', 'const the the = 1;\n'));
  client.sendLsp('textDocument/didChange', didChangeParams(SCRIPT_URI, 2, 'const the the = 2;\n'));
  await delay(VISIONS_DEBOUNCE_MS * 4);
  assert.deepEqual(client.frames, [], 'v1 says nothing about code buffers');

  client.sendLsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  assert.ok(await waitForDiagnostics(client, MARKDOWN_URI), 'the connection survived the malformed frame');
});

test('a default config leaves /visions exactly where an unowned path is left', async () => {
  const { server, port } = await bootBackend({});
  assert.equal(
    await backendDestroyedUpgrade(server, port, '/visions'), false,
    'untouched on the local listener, so Vite HMR can still claim it',
  );
  assert.equal(
    await backendDestroyedUpgrade(server, port, '/some-other-app'), false,
    'byte-for-byte the unknown-path behavior',
  );
});

test('a config with visions present but not enabled stays inert', async () => {
  const { server, port } = await bootBackend({ visions: { enabled: false } });
  assert.equal(await backendDestroyedUpgrade(server, port, '/visions'), false);
});

test('/visions is refused on the remote listener even with the lane enabled', async () => {
  const remotePort = await reserveFreePort();
  const { server, port, remoteServer } = await bootBackend({
    visions: { enabled: true },
    remote: { enabled: true, port: remotePort, publicHost: 'glissa.test', allowedOrigins: ['https://glissa.test'] },
  }, { remotePort });

  assert.equal(
    await backendDestroyedUpgrade(remoteServer, remotePort, '/visions'), true,
    'buffer text never crosses the remote boundary in v1',
  );
  assert.equal(
    await backendDestroyedUpgrade(server, port, '/visions'), false,
    'the same lane is served on the local listener',
  );
});

test('visions is echoed by getSettings and applied as a restart-required settings block', () => {
  assert.equal(BOOLEAN_KEYS.includes('visions'), false);
  assert.equal(STRING_KEYS.includes('visions'), false);
  assert.equal(TIMEOUT_KEYS.includes('visions'), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-visions-settings-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [], teams: [], visions: { enabled: true } }, null, 2), 'utf8');
  const previousEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  try {
    const store = createConfigStore();
    assert.deepEqual(store.getSettings().visions, { enabled: true });
    store.applySettings({ projects: [], visions: { enabled: false } });
    assert.deepEqual(store.config.visions, { enabled: false });
  } finally {
    if (previousEnv == null) delete process.env.GLISSA_CONFIG;
    if (previousEnv != null) process.env.GLISSA_CONFIG = previousEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- The ingest context digest (docs/plan-ingestion.md, M6) ---

test('with no ingest lane injected the dispatch carries an empty digest and nothing is ever called', async (t) => {
  const { wiring, timers, calls, lsp } = dispatchingConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].digest, '');
});

test('the digest is read once per dispatch and rides into the prompt builder', async (t) => {
  const digestCalls = [];
  const { wiring, timers, calls, lsp } = dispatchingConnection({
    contextDigest: (args) => {
      digestCalls.push(args);
      return 'Recent activity on this machine, newest first:\n- terminal 4s ago: npm test';
    },
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  assert.equal(digestCalls.length, 1, 'exactly once per dispatch, never on publish');
  assert.equal(digestCalls[0].budgetChars, DIGEST_BUDGET_CHARS);
  assert.equal(digestCalls[0].now, FIXED_TS);
  assert.ok(calls[0].digest.includes('- terminal 4s ago: npm test'));
});

test('a sweep that never dispatches never asks the ingest lane for a digest', async (t) => {
  const digestCalls = [];
  const { wiring, timers, lsp } = drivenConnection({ contextDigest: () => { digestCalls.push(1); return 'x'; } });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  timers.runPending();

  assert.equal(digestCalls.length, 0);
});

test('a throwing ingest lane costs the prompt its context section, never the dispatch', async (t) => {
  const { wiring, timers, calls, warnings, lsp } = dispatchingConnection({
    contextDigest: () => { throw new Error('rings unavailable'); },
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  assert.equal(calls.length, 1, 'the dispatch still happened');
  assert.equal(calls[0].digest, '');
  assert.ok(warnings.some((message) => message.includes('rings unavailable')));
});

test('a digest that is not a string is treated as absent rather than stringified into the prompt', async (t) => {
  const { wiring, timers, calls, lsp } = dispatchingConnection({ contextDigest: () => ({ oops: true }) });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  assert.equal(calls[0].digest, '');
});

// --- Activity-driven dispatch (docs/plan-ingestion.md, M7.5) ---

/*
 * The lane as it stands on the operator's machine when the bug bites: one markdown buffer open, nobody
 * typing, and the only thing still moving is the ingest timeline. `machine.seq` stands in for the ingest
 * lane's latestSeq(), and noteActivity() for the poke its batch delivers.
 */
function pokableConnection({ dispatch: overrides = {}, respond = null } = {}) {
  const machine = { seq: 0 };
  const context = dispatchingConnection({
    dispatch: { cooldownMs: 1, ...overrides },
    respond,
    contextSeq: () => machine.seq,
  });
  return { ...context, machine };
}

test('a poke arms one quiet window per open markdown buffer and leaves other documents alone', async (t) => {
  const otherUri = 'file:///tmp/other.markdown';
  const {
    wiring, connection, timers, lsp,
  } = pokableConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didOpen', didOpenParams(otherUri, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didOpen', didOpenParams(SCRIPT_URI, 'javascript', 'const the the = 1;\n'));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(timers.pendingCount, 0, 'the editor-driven windows have all run out');

  wiring.noteActivity();
  assert.equal(connection.pendingDispatchCount, 2, 'the code buffer is not a visions document in v1');
  assert.equal(timers.pendingCount, 2);
});

test('a stream of activity never resets an armed window, or a busy machine would starve dispatch', async (t) => {
  const { wiring, timers, lsp } = pokableConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  wiring.noteActivity();
  const armed = timers.pendingIds;
  assert.equal(armed.length, 1);
  wiring.noteActivity();
  wiring.noteActivity();
  assert.deepEqual(timers.pendingIds, armed, 'the same window, not a fresh one pushed further out');
});

test('a closed connection is poked no more than a closed buffer is', async (t) => {
  const {
    wiring, connection, timers, lsp,
  } = pokableConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  connection.close();
  wiring.noteActivity();
  assert.equal(connection.pendingDispatchCount, 0);
  assert.equal(timers.pendingCount, 0);
});

test('activity alone re-dispatches an untouched buffer, and the belief it comes back with lands', async (t) => {
  const {
    wiring, timers, calls, lsp, clock, machine,
  } = pokableConnection({
    respond: () => Promise.resolve({
      verdict: 'NONE', comments: [], intent: 'wiring the ingest lane into the visions gate', reason: null,
    }),
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1);

  // Nobody typed: the buffer is the same text, and only the machine around it moved.
  clock.now += 60000;
  machine.seq = 4;
  wiring.noteActivity();
  timers.runPending();
  await wiring.whenDispatchSettled();

  assert.equal(calls.length, 2, 'new events are what re-open a document nobody is editing');
  assert.equal(calls[1].text, REPEATED_WORD_MARKDOWN);
  assert.equal(wiring.getIntentFor().text, 'wiring the ingest lane into the visions gate');
});

test('a poke with no new events behind it is refused, so an aging digest cannot buy a dispatch', async (t) => {
  const {
    wiring, timers, calls, notes, lsp, clock, machine,
  } = pokableConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  clock.now += 60000;
  machine.seq = 3;
  wiring.noteActivity();
  timers.runPending();
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 2, 'the first poke after real activity dispatches');

  clock.now += 60000;
  wiring.noteActivity();
  timers.runPending();
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 2, 'the seq stood still, so nothing about the machine has moved');
  assert.ok(notes.some((line) => line.includes('unchanged')));
});

test('the cooldown still holds a document a busy machine keeps poking', async (t) => {
  const {
    wiring, timers, calls, notes, lsp, clock, machine,
  } = pokableConnection({ dispatch: { cooldownMs: 300000 } });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  for (let event = 1; event <= 5; event += 1) {
    clock.now += 1000;
    machine.seq += 1;
    wiring.noteActivity();
    timers.runPending();
    await wiring.whenDispatchSettled();
  }
  assert.equal(calls.length, 1, 'at most one dispatch per cooldown window, however loud the machine is');
  assert.ok(notes.some((line) => line.includes('cooldown')));
});

test('with no ingest lane wired a poke changes nothing about what the gate decides', async (t) => {
  const {
    wiring, calls, notes, timers, lsp, clock,
  } = dispatchingConnection({ dispatch: { cooldownMs: 1 } });
  t.after(() => wiring.stop());
  assert.equal(wiring.latestContextSeq(), null);

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  clock.now += 60000;
  wiring.noteActivity();
  timers.runPending();
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1, 'the buffer-only gate, exactly as it was before M7.5');
  assert.ok(notes.some((line) => line.includes('unchanged')));
});

test('a lane with dispatch off arms nothing at all when the machine moves', (t) => {
  const { wiring, connection, timers, lsp } = drivenConnection({ contextSeq: () => 9 });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  wiring.noteActivity();
  assert.equal(connection.pendingDispatchCount, 0);
  assert.equal(timers.pendingCount, 0);
});

test('a seq provider that throws costs the movement signal, never the dispatch', async (t) => {
  const { wiring, timers, calls, warnings, lsp } = dispatchingConnection({
    contextSeq: () => { throw new Error('rings unavailable'); },
  });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  assert.equal(calls.length, 1, 'the edit-driven dispatch still happened');
  assert.ok(warnings.some((message) => message.includes('rings unavailable')));
  assert.equal(wiring.latestContextSeq(), null);
});

test('the machine cannot poke its way past its own quota, and typing still gets through', async (t) => {
  const {
    wiring, timers, calls, notes, lsp, clock, machine,
  } = pokableConnection({ dispatch: { activityMaxPerHour: 1 } });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1, 'the buffer was read once when it was opened');

  for (let event = 1; event <= 3; event += 1) {
    clock.now += 1000;
    machine.seq += 1;
    wiring.noteActivity();
    timers.runPending();
    await wiring.whenDispatchSettled();
  }
  assert.equal(calls.length, 2, 'one activity dispatch, which is the whole quota');
  assert.ok(notes.some((line) => line.includes('activity-cap')));

  // What the quota exists to protect: the carbon unit saves, and the budget is still there for them.
  clock.now += 1000;
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, '# Title\n\nA sentence they just typed.\n'));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 3, 'an edit answers to the total budget only');
});

/*
 * The cold start at the wiring altitude: a buffer whose first sweep-armed window was turned away has no
 * recorded hash, so when a poke later arms it the gate has nothing to read but the arming reason. The
 * quota is zero here, which makes the classification directly visible: 'activity-cap' can only be
 * reached by a dispatch classified as the machine's, and 'hour-cap' is what a misread would say.
 */
test('a buffer first read after a poke is charged to the machine, not to nobody typing', async (t) => {
  const otherUri = 'file:///tmp/other.md';
  const {
    wiring, timers, calls, notes, lsp, clock, machine,
  } = pokableConnection({ dispatch: { maxPerHour: 1 } });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1, 'the first buffer spends the whole budget');

  lsp('textDocument/didOpen', didOpenParams(otherUri, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1);
  assert.ok(notes.some((line) => line.includes('hour-cap')), 'its sweep-armed window was turned away, so it recorded no hash');

  // Only the second buffer stays open, so the poke below reaches exactly one document.
  lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  clock.now += 1000;
  machine.seq = 5;
  wiring.noteActivity();
  timers.runPending();
  await wiring.whenDispatchSettled();

  assert.equal(calls.length, 1);
  assert.ok(
    notes.some((line) => line.includes('activity-cap')),
    `a poke-armed first read must be classified as activity, saw ${JSON.stringify(notes)}`,
  );
});

test('a refusal is logged when the gate changes, not once per quiet window forever', async (t) => {
  const {
    wiring, timers, calls, notes, lsp, clock, machine,
  } = pokableConnection();
  t.after(() => wiring.stop());
  const unchangedLines = () => notes.filter((line) => line.includes('unchanged')).length;

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  for (let poke = 0; poke < 4; poke += 1) {
    clock.now += 1000;
    wiring.noteActivity();
    timers.runPending();
    await wiring.whenDispatchSettled();
  }
  assert.equal(calls.length, 1, 'nothing moved, so nothing dispatched');
  assert.equal(unchangedLines(), 1, 'the same gate holding again is the steady state, not news');

  clock.now += 1000;
  machine.seq = 9;
  wiring.noteActivity();
  timers.runPending();
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 2);

  clock.now += 1000;
  wiring.noteActivity();
  timers.runPending();
  await wiring.whenDispatchSettled();
  assert.equal(unchangedLines(), 2, 'a dispatch happened in between, so the next refusal is news again');
});

// The operator's own save being turned away is the one refusal that must always reach the log, even
// when a poke was already refused by the same cap moments earlier.
test('a save refused by the same cap as a poke is logged, not swallowed as a repeat', async (t) => {
  const otherUri = 'file:///tmp/other.md';
  const {
    wiring, timers, calls, notes, lsp, clock, machine,
  } = pokableConnection({ dispatch: { maxPerHour: 2, activityMaxPerHour: 1 } });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  lsp('textDocument/didOpen', didOpenParams(otherUri, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 2, 'two buffers read once each, and the hourly budget is spent');
  lsp('textDocument/didClose', { textDocument: { uri: otherUri } });

  clock.now += 1000;
  machine.seq = 5;
  wiring.noteActivity();
  timers.runPending();
  await wiring.whenDispatchSettled();

  clock.now += 1000;
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, '# Title\n\nA sentence they just typed.\n'));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  await wiring.whenDispatchSettled();

  const hourCapLines = notes.filter((line) => line.includes('hour-cap'));
  assert.equal(hourCapLines.length, 2, `both refusals are news, saw ${JSON.stringify(notes)}`);
  assert.ok(hourCapLines.some((line) => line.includes('(activity)')));
  assert.ok(hourCapLines.some((line) => line.includes('(edit)')));
});

test('a seq that is not a finite number is read as no lane rather than as movement', async (t) => {
  const {
    wiring, timers, calls, lsp, clock,
  } = dispatchingConnection({ dispatch: { cooldownMs: 1 }, contextSeq: () => '12' });
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  runSweepThenDispatch(timers);
  await wiring.whenDispatchSettled();

  clock.now += 60000;
  wiring.noteActivity();
  timers.runPending();
  await wiring.whenDispatchSettled();
  assert.equal(calls.length, 1);
  assert.equal(wiring.latestContextSeq(), null);
});
