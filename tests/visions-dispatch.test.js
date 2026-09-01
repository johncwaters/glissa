'use strict';

// The visions dispatch shell: the result-file contract, the hard timeout, the throwaway work dir,
// and the permissions posture the lane spawns under. The spawn itself is injected, so NOTHING here
// starts a real claude session.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PROMPT_FILE,
  RESULT_FILE,
  VISIONS_BOOTSTRAP_PROMPT,
  VISIONS_DENY_TOOLS,
  createVisionsDispatcher,
  readCommentsResult,
  visionsPermissions,
} = require('../server/visions-dispatch');
const { MAX_PROMPT_BYTES, buildVisionsPrompt } = require('../server/core/visions-dispatch-core.ts');

const URI = 'file:///tmp/plan-visions.md';
const TEXT = '# Title\n\nA plan with three lines.\n';

function tempFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-visions-result-'));
  const file = path.join(dir, RESULT_FILE);
  if (contents != null) fs.writeFileSync(file, contents, 'utf8');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// --- Reading what a session claimed ---

test('a COMMENTS result is believed for the entries that pass validation', async (t) => {
  const { file, cleanup } = tempFile(JSON.stringify({
    verdict: 'COMMENTS',
    comments: [
      { line: 2, message: 'The title promises a plan the body never gives.' },
      { line: 99, message: 'past the end of the buffer' },
    ],
  }));
  t.after(cleanup);

  assert.deepEqual(await readCommentsResult(file, { lineCount: 4 }), {
    verdict: 'COMMENTS',
    comments: [{ line: 2, message: 'The title promises a plan the body never gives.' }],
    diagnostics: [],
    intent: null,
    hand: null,
    outOfRange: 1,
    errorSource: null,
    reason: null,
  });
});

test('NONE is a first-class answer, and carries no comments', async (t) => {
  const { file, cleanup } = tempFile(JSON.stringify({ verdict: 'none', comments: [] }));
  t.after(cleanup);
  assert.deepEqual(await readCommentsResult(file, { lineCount: 4 }), {
    verdict: 'NONE', comments: [], diagnostics: [], intent: null, hand: null, outOfRange: 0, errorSource: null, reason: null,
  });
});

test('a COMMENTS verdict whose every entry is junk reports NONE and says why', async (t) => {
  const { file, cleanup } = tempFile(JSON.stringify({ verdict: 'COMMENTS', comments: [{ line: 0, message: '' }] }));
  t.after(cleanup);
  const result = await readCommentsResult(file, { lineCount: 4 });
  assert.equal(result.verdict, 'NONE');
  assert.deepEqual(result.comments, []);
  assert.match(result.reason, /survived validation/);
});

test('a missing, unparsable, non-object or unknown-verdict file is an ERROR, never a comment', async (t) => {
  const missing = path.join(os.tmpdir(), `glissa-visions-absent-${process.pid}.json`);
  assert.deepEqual(await readCommentsResult(missing), {
    verdict: 'ERROR', comments: [], diagnostics: [], intent: null, hand: null, outOfRange: 0, errorSource: 'transport', reason: 'no readable result file',
  });

  const bad = tempFile('{not json');
  t.after(bad.cleanup);
  assert.equal((await readCommentsResult(bad.file)).verdict, 'ERROR');

  // A file that exists proves the session ran, so an unparsable one is its output, never lane evidence.
  const unparsable = await readCommentsResult(bad.file);
  assert.equal(unparsable.errorSource, 'session');
  assert.equal(unparsable.reason, 'result file is not JSON');
  const absent = await readCommentsResult(path.join(os.tmpdir(), `glissa-visions-gone-${process.pid}.json`));
  assert.equal(
    absent.errorSource, 'transport',
    'NO file is the rate-limit signature the backoff exists to catch, so it stays transport',
  );

  const array = tempFile(JSON.stringify([{ verdict: 'COMMENTS' }]));
  t.after(array.cleanup);
  const arrayResult = await readCommentsResult(array.file);
  assert.match(arrayResult.reason, /not an object/);
  assert.equal(arrayResult.errorSource, 'session');

  const unknown = tempFile(JSON.stringify({ verdict: 'LOOKS_FINE', comments: [{ line: 1, message: 'trust me' }] }));
  t.after(unknown.cleanup);
  assert.deepEqual(await readCommentsResult(unknown.file, { lineCount: 4 }), {
    verdict: 'ERROR', comments: [], diagnostics: [], intent: null, hand: null, outOfRange: 0, errorSource: 'session', reason: 'invalid verdict in result file',
  });
});

test('an ERROR verdict cannot carry result surfaces', async (t) => {
  const claimed = tempFile(JSON.stringify({
    verdict: 'ERROR',
    comments: [{ line: 1, message: 'do not show this' }],
    diagnostics: [{ line: 1, message: 'do not publish this' }],
    intent: 'do not believe this',
    hand: 'do not raise this',
  }));
  t.after(claimed.cleanup);

  assert.deepEqual(await readCommentsResult(claimed.file, { lineCount: 4 }), {
    verdict: 'ERROR',
    comments: [],
    diagnostics: [],
    intent: null,
    hand: null,
    outOfRange: 0,
    errorSource: 'session',
    reason: 'session reported an error verdict',
  });
});

// The size the caller logs comes from the read this already did, never from a second stat of the file.
test('onBytesRead reports what was read without changing the result shape', async (t) => {
  const content = JSON.stringify({ verdict: 'NONE', comments: [] });
  const { file, cleanup } = tempFile(content);
  t.after(cleanup);

  const sizes = [];
  assert.deepEqual(await readCommentsResult(file, { lineCount: 4, onBytesRead: (bytes) => sizes.push(bytes) }), {
    verdict: 'NONE', comments: [], diagnostics: [], intent: null, hand: null, outOfRange: 0, errorSource: null, reason: null,
  });
  assert.deepEqual(sizes, [Buffer.byteLength(content)]);

  // A file that could not be read reports nothing at all, so the caller's count stays 0.
  const missing = path.join(os.tmpdir(), `glissa-visions-absent-${process.pid}.json`);
  const missed = [];
  assert.equal((await readCommentsResult(missing, { onBytesRead: (bytes) => missed.push(bytes) })).verdict, 'ERROR');
  assert.deepEqual(missed, []);
});

// --- The optional intent field (docs/archive/plan-navigator.md, M5) ---

test('an intent claim is read, trimmed and capped, whatever the verdict says', async (t) => {
  const withComments = tempFile(JSON.stringify({
    verdict: 'COMMENTS',
    comments: [{ line: 1, message: 'Name the audience.' }],
    intent: '  a plan doc for the visions intent model  ',
  }));
  t.after(withComments.cleanup);
  assert.deepEqual((await readCommentsResult(withComments.file, { lineCount: 4 })).intent, { thread: null, text: 'a plan doc for the visions intent model' });

  // A session with nothing to comment on can still have moved its belief.
  const quiet = tempFile(JSON.stringify({ verdict: 'NONE', comments: [], intent: 'a quieter belief' }));
  t.after(quiet.cleanup);
  assert.deepEqual((await readCommentsResult(quiet.file, { lineCount: 4 })).intent, { thread: null, text: 'a quieter belief' });

  const long = tempFile(JSON.stringify({ verdict: 'NONE', comments: [], intent: 'z'.repeat(700) }));
  t.after(long.cleanup);
  assert.equal((await readCommentsResult(long.file, { lineCount: 4 })).intent.text.length, 300);
});

test('an invalid intent claim is ignored rather than believed or thrown over', async (t) => {
  for (const intent of ['', '   ', 42, { text: 'nope' }, ['nope'], null]) {
    const { file, cleanup } = tempFile(JSON.stringify({ verdict: 'NONE', comments: [], intent }));
    t.after(cleanup);
    const result = await readCommentsResult(file, { lineCount: 4 });
    assert.equal(result.intent, null, `${JSON.stringify(intent)} is not an updated belief`);
    assert.equal(result.verdict, 'NONE', 'and it never invalidates the rest of the result');
  }
});

// --- The optional raised-hand field (docs/archive/plan-navigator-2.md, M7) ---

test('a hand claim is read, trimmed and capped, whatever the verdict says', async (t) => {
  const withComments = tempFile(JSON.stringify({
    verdict: 'COMMENTS',
    comments: [{ line: 1, message: 'Name the audience.' }],
    hand: '  the middle sections argue at different altitudes  ',
  }));
  t.after(withComments.cleanup);
  assert.equal((await readCommentsResult(withComments.file, { lineCount: 4 })).hand, 'the middle sections argue at different altitudes');

  const quiet = tempFile(JSON.stringify({ verdict: 'NONE', comments: [], hand: 'the document has two competing goals' }));
  t.after(quiet.cleanup);
  assert.equal((await readCommentsResult(quiet.file, { lineCount: 4 })).hand, 'the document has two competing goals');

  const long = tempFile(JSON.stringify({ verdict: 'NONE', comments: [], hand: 'z'.repeat(700) }));
  t.after(long.cleanup);
  assert.equal((await readCommentsResult(long.file, { lineCount: 4 })).hand.length, 300);
});

test('an invalid or absent hand claim is ignored rather than believed or thrown over', async (t) => {
  for (const hand of [undefined, '', '   ', 42, { text: 'nope' }, ['nope'], null]) {
    const { file, cleanup } = tempFile(JSON.stringify({ verdict: 'NONE', comments: [], hand }));
    t.after(cleanup);
    const result = await readCommentsResult(file, { lineCount: 4 });
    assert.equal(result.hand, null, `${JSON.stringify(hand)} is not a raised hand`);
    assert.equal(result.verdict, 'NONE', 'and it never invalidates the rest of the result');
  }
});

test('diagnostics are read, validated and capped independently from comments', async (t) => {
  const { file, cleanup } = tempFile(JSON.stringify({
    verdict: 'COMMENTS',
    comments: [{ line: 1, message: 'Name the audience.' }],
    diagnostics: [
      { line: 2, message: '  a factual issue  ' },
      { line: 99, message: 'past the end' },
      { line: 3, message: 'z'.repeat(500) },
    ],
  }));
  t.after(cleanup);

  const result = await readCommentsResult(file, { lineCount: 4 });
  assert.deepEqual(result.diagnostics, [
    { line: 2, message: 'a factual issue' },
    { line: 3, message: 'z'.repeat(300) },
  ]);
});

test('absent or non-array diagnostics read as empty', async (t) => {
  for (const diagnostics of [undefined, null, { line: 1, message: 'not a list' }, 'nope']) {
    const { file, cleanup } = tempFile(JSON.stringify({ verdict: 'NONE', comments: [], diagnostics }));
    t.after(cleanup);
    assert.deepEqual((await readCommentsResult(file, { lineCount: 4 })).diagnostics, []);
  }
});

// --- One dispatch, end to end, with the spawn injected ---

// Ref'd on purpose: the timeout test injects every timer the dispatcher arms, so an unref'd handle
// would be the only thing left in the loop and node exits before it can fire.
function eventLoopTurn() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 2); });
  }
  throw new Error('condition was not reached');
}

function dispatcherWithSpawn(spawnSession, overrides = {}) {
  const workDirs = [];
  const dispatch = createVisionsDispatcher({
    spawnSession,
    makeWorkDir: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-visions-test-'));
      workDirs.push(dir);
      return dir;
    },
    idFor: (uri) => `visions:${uri}`,
    ...overrides,
  });
  return { dispatch, workDirs };
}

test('a session that writes the result file yields its comments, and the work dir is removed after', async () => {
  const seen = [];
  let promptOnDisk = null;
  const { dispatch, workDirs } = dispatcherWithSpawn(async (args) => {
    seen.push(args);
    promptOnDisk = fs.readFileSync(path.join(args.cwd, PROMPT_FILE), 'utf8');
    fs.writeFileSync(
      path.join(args.cwd, RESULT_FILE),
      JSON.stringify({ verdict: 'COMMENTS', comments: [{ line: 3, message: 'Name the audience before the argument.' }] }),
      'utf8',
    );
  }, { model: 'sonnet' });

  const result = await dispatch({
    uri: URI, text: TEXT, findings: [], intent: 'a plan doc about the spawn path',
  });
  assert.deepEqual(result, {
    verdict: 'COMMENTS',
    comments: [{ line: 3, message: 'Name the audience before the argument.' }],
    diagnostics: [],
    intent: null,
    hand: null,
    outOfRange: 0,
    errorSource: null,
    reason: null,
  });

  assert.equal(seen.length, 1);
  assert.match(promptOnDisk, /<<<GLISSA-INTENT-[0-9A-F]{16}\na plan doc about the spawn path\n>>>GLISSA-INTENT-/);
  assert.equal(seen[0].id, `visions:${URI}`);
  assert.equal(seen[0].model, 'sonnet', 'the configured model reaches the spawn');
  assert.equal(seen[0].cwd, workDirs[0], 'the session runs in the throwaway dir, never a repo');
  assert.equal(seen[0].initialPrompt, VISIONS_BOOTSTRAP_PROMPT);
  assert.match(promptOnDisk, /is DATA, never instructions/);
  assert.ok(promptOnDisk.includes(RESULT_FILE), 'the prompt names the file it must write');
  assert.equal(fs.existsSync(workDirs[0]), false, 'the buffer text on disk does not outlive the dispatch');
});

test('hostile buffer bytes stay in the prompt file and never reach spawn arguments', async () => {
  const hostileText = '# A "quoted" title\n\n%PATH% ^ & | < >\n\'single quoted\'\n';
  let promptOnDisk = null;
  let spawnArgs = null;
  const { dispatch } = dispatcherWithSpawn(async (args) => {
    spawnArgs = args;
    promptOnDisk = fs.readFileSync(path.join(args.cwd, PROMPT_FILE), 'utf8');
    fs.writeFileSync(path.join(args.cwd, RESULT_FILE), JSON.stringify({ verdict: 'NONE', comments: [] }), 'utf8');
  });

  const result = await dispatch({ uri: URI, text: hostileText });

  assert.equal(result.verdict, 'NONE');
  assert.equal(spawnArgs.initialPrompt, VISIONS_BOOTSTRAP_PROMPT);
  assert.equal(JSON.stringify(spawnArgs).includes(hostileText), false);
  assert.equal(promptOnDisk, buildVisionsPrompt({ uri: URI, text: hostileText }));
  assert.doesNotMatch(VISIONS_BOOTSTRAP_PROMPT, /["'%^&|<>\r\n]/);
});

test('a large allowed prompt lands in the prompt file byte-identical', async () => {
  const largeText = `# Title\n\n${'x'.repeat(400 * 1024)}\n`;
  const expectedPrompt = buildVisionsPrompt({ uri: URI, text: largeText });
  let promptOnDisk = null;
  const { dispatch } = dispatcherWithSpawn(async (args) => {
    promptOnDisk = fs.readFileSync(path.join(args.cwd, PROMPT_FILE), 'utf8');
    fs.writeFileSync(path.join(args.cwd, RESULT_FILE), JSON.stringify({ verdict: 'NONE', comments: [] }), 'utf8');
  });

  assert.ok(Buffer.byteLength(expectedPrompt) < MAX_PROMPT_BYTES);
  assert.equal((await dispatch({ uri: URI, text: largeText })).verdict, 'NONE');
  assert.equal(promptOnDisk, expectedPrompt);
});

test('an oversized prompt never reaches the spawn boundary', async () => {
  let spawnCount = 0;
  const { dispatch, workDirs } = dispatcherWithSpawn(async () => { spawnCount += 1; });

  const result = await dispatch({ uri: URI, text: 'x'.repeat(MAX_PROMPT_BYTES) });

  assert.equal(result.verdict, 'ERROR');
  assert.equal(result.reason, 'prompt-too-large');
  assert.equal(spawnCount, 0);
  assert.equal(fs.existsSync(workDirs[0]), false);
});

test('a session that writes nothing is an ERROR with a reason, and still cleans up', async () => {
  const { dispatch, workDirs } = dispatcherWithSpawn(async () => {});
  const result = await dispatch({ uri: URI, text: TEXT });
  assert.equal(result.verdict, 'ERROR');
  assert.deepEqual(result.comments, []);
  assert.equal(fs.existsSync(workDirs[0]), false);
});

test('a spawn that throws becomes an ERROR verdict rather than a rejected dispatch', async () => {
  const { dispatch } = dispatcherWithSpawn(async () => { throw new Error('claude is not on PATH'); });
  const result = await dispatch({ uri: URI, text: TEXT });
  assert.deepEqual(result, {
    verdict: 'ERROR', comments: [], diagnostics: [], intent: null, hand: null, outOfRange: 0, errorSource: 'transport', reason: 'claude is not on PATH',
  });
});

test('a hung session is aborted at the hard timeout and resolves ERROR, so the lane never pins', async () => {
  let fire = null;
  let timeoutMs = null;
  let aborted = false;
  let readAttempts = 0;
  const { dispatch, workDirs } = dispatcherWithSpawn(
    ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
    }),
    {
      timeoutSeconds: 12,
      setTimeoutFn: (fn, ms) => { fire = fn; timeoutMs = ms; return { unref() { return this; } }; },
      clearTimeoutFn: () => {},
      readResult: async () => { readAttempts += 1; return { verdict: 'NONE', comments: [], reason: null }; },
    },
  );

  const pending = dispatch({ uri: URI, text: TEXT });
  await waitUntil(() => fire !== null);
  assert.equal(timeoutMs, 12000, 'dispatchTimeoutSeconds is seconds on the wire, milliseconds on the timer');
  assert.equal(aborted, false, 'nothing is aborted while the session still has time');

  // The injected timer never fires on its own; firing it here IS the hard timeout.
  fire();
  assert.deepEqual(await pending, {
    verdict: 'ERROR', comments: [], diagnostics: [], intent: null, hand: null, outOfRange: 0, errorSource: 'transport', reason: 'dispatch timed out',
  });
  await eventLoopTurn();
  assert.equal(aborted, true, 'the session was told to stop, not just abandoned');
  assert.equal(readAttempts, 0, 'a timeout never reads from the removed work dir');
  await waitUntil(() => !fs.existsSync(workDirs[0]));
});

// The work dir is the killed session's own cwd: removing it under a live process leaks it on Windows and yanks it from a POSIX process still writing.
test('a timed-out dispatch waits for the killed session before removing its work dir', async () => {
  let fire = null;
  let releaseSpawn = null;
  // The removal is observed through the injected dep, not through existsSync: a real rm lands some
  // ticks later either way, so only the CALL says whether it waited for the session.
  const removals = [];
  const { dispatch, workDirs } = dispatcherWithSpawn(
    () => new Promise((resolve) => { releaseSpawn = resolve; }),
    {
      timeoutSeconds: 12,
      setTimeoutFn: (fn) => { fire = fn; return { unref() { return this; } }; },
      clearTimeoutFn: () => {},
      removeWorkDir: async (dir) => { removals.push(dir); await fs.promises.rm(dir, { recursive: true, force: true }); },
    },
  );

  const pending = dispatch({ uri: URI, text: TEXT });
  await waitUntil(() => fire !== null);
  fire();
  await eventLoopTurn();
  assert.deepEqual(removals, [], 'the cwd outlives the verdict, not the process');

  releaseSpawn();
  assert.deepEqual(await pending, {
    verdict: 'ERROR', comments: [], diagnostics: [], intent: null, hand: null, outOfRange: 0, errorSource: 'transport', reason: 'dispatch timed out',
  });
  assert.deepEqual(removals, [workDirs[0]], 'and is removed once the session is gone');
  assert.equal(fs.existsSync(workDirs[0]), false);
});

test('a dispatcher with no spawn injected refuses to be built', () => {
  assert.throws(() => createVisionsDispatcher({}), /requires spawnSession/);
});

// --- The permissions posture, pinned ---

/*
 * Probed against the real CLI (2.1.241) via the stream-json tool_result: neither `Write(<dir>/**)` nor
 * `Edit(<dir>/**)` in an allow list grants the Write tool, a path deny does not refuse one, and a bare
 * `Read` deny does. What bounds the writes is acceptEdits over the throwaway cwd. Changing any of it is
 * a security decision, so it costs a test edit.
 */
test('the lane bounds its writes with acceptEdits over its cwd, no allow list, no skip-permissions', () => {
  const posture = visionsPermissions();
  assert.equal(posture.permissions.defaultMode, 'acceptEdits');
  assert.equal(Object.hasOwn(posture.permissions, 'allow'), false);
  assert.deepEqual(VISIONS_DENY_TOOLS, ['Bash', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']);
  for (const tool of ['Read', 'Write', 'Glob', 'Grep']) {
    assert.equal(posture.permissions.deny.includes(tool), false, `${tool} must not be denied: a bare deny of it refuses the result-file write`);
  }
});

// --- Intent threads in the result contract (docs/plan-visions-4-focus.md, M20) ---

test('the object intent form survives with its thread, and a bad thread value is dropped', async (t) => {
  const named = tempFile(JSON.stringify({ verdict: 'NONE', comments: [], intent: { thread: 't-716d49b4', text: '  story A, refined  ' } }));
  t.after(named.cleanup);
  assert.deepEqual((await readCommentsResult(named.file, { lineCount: 4 })).intent, { thread: 't-716d49b4', text: 'story A, refined' });

  const opened = tempFile(JSON.stringify({ verdict: 'NONE', comments: [], intent: { thread: 'new', text: 'story B' } }));
  t.after(opened.cleanup);
  assert.deepEqual((await readCommentsResult(opened.file, { lineCount: 4 })).intent, { thread: 'new', text: 'story B' });

  // A null thread is the parsed form of a plain string, so it reads back as an advance of the active one.
  const active = tempFile(JSON.stringify({ verdict: 'NONE', comments: [], intent: { thread: null, text: 'story C' } }));
  t.after(active.cleanup);
  assert.deepEqual((await readCommentsResult(active.file, { lineCount: 4 })).intent, { thread: null, text: 'story C' });

  for (const intent of [{ thread: 'T-716D49B4', text: 'x' }, { thread: 't-716d49b', text: 'x' }, { thread: 'new', text: '' }, { thread: 7, text: 'x' }]) {
    const { file, cleanup } = tempFile(JSON.stringify({ verdict: 'NONE', comments: [], intent }));
    t.after(cleanup);
    const result = await readCommentsResult(file, { lineCount: 4 });
    assert.equal(result.intent, null, `${JSON.stringify(intent)} is not an accepted proposal`);
    assert.equal(result.verdict, 'NONE');
  }
});

test('a comment basis rides through the result reader as shape, never as policy', async (t) => {
  const { file, cleanup } = tempFile(JSON.stringify({
    verdict: 'COMMENTS',
    comments: [{ line: 1, message: 'on the edit', basis: 'edit' }, { line: 2, message: 'untagged' }, { line: 3, message: 'junk basis', basis: 'vibes' }],
  }));
  t.after(cleanup);
  const result = await readCommentsResult(file, { lineCount: 4 });
  assert.deepEqual(result.comments, [
    { line: 1, message: 'on the edit', basis: 'edit' },
    { line: 2, message: 'untagged' },
    { line: 3, message: 'junk basis' },
  ]);
});
