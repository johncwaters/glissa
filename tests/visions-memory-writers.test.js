'use strict';

// M13 of docs/plan-visions-3.md: the Visions funnels that write to the memory store, driven with a fake
// store. Trust fields are stamped by the writer, a null store writes nothing, and a store that refuses
// or throws never reaches the relay or the dispatch path.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createVisionsWiring } = require('../server/visions-wiring');

const PROJECT_ID = 'e1f4c0de-0000-4000-8000-000000000001';
const PROJECT_PATH = '/tmp/glissa-memory-writers';
const MARKDOWN_URI = `file://${PROJECT_PATH}/plan.md`;
const OUTSIDE_URI = 'file:///tmp/elsewhere/plan.md';
const SCOPE_PROJECTS = [{ id: PROJECT_ID, path: PROJECT_PATH }];
const REPEATED_WORD_MARKDOWN = '# Title\n\nA line with with a repeat.\n';
const FIXED_TS = 1700000000000;

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
  };
}

function fakeMemoryStore({
  refuse = false, refuseFirst = false, throws = false, seeded = [],
} = {}) {
  const appended = [];
  let minted = 0;
  return {
    appended,
    records: () => seeded.slice(),
    append(input) {
      appended.push(input);
      if (throws) return Promise.reject(new Error('the canon is unwritable'));
      if (refuse || (refuseFirst && appended.length === 1)) return Promise.resolve(null);
      minted += 1;
      return Promise.resolve({ ...input, id: `m-${minted}` });
    },
  };
}

function harness({ store = null, ...options } = {}) {
  const timers = fakeTimers();
  const warnings = [];
  const sent = [];
  const wiring = createVisionsWiring({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: () => FIXED_TS,
    logger: { warn: (message) => warnings.push(message), log: () => {} },
    scopeProjects: SCOPE_PROJECTS,
    getMemoryStore: store ? () => store : null,
    ...options,
  });
  const connection = wiring.openConnection({ send: (message) => sent.push(message) });
  return {
    wiring,
    connection,
    timers,
    warnings,
    sent,
    lsp: (method, params) => connection.handleFrame(JSON.stringify({ type: 'lsp', method, params })),
    request: (id, method, params) => connection.handleFrame(JSON.stringify({
      type: 'lsp-request', id, method, params,
    })),
    respond: (id, result) => connection.handleFrame(JSON.stringify({ type: 'lsp-response', id, result })),
  };
}

// Opened and then edited, since an unedited buffer is an orientation that carries no comments (M19).
function openMarkdown(driver, uri = MARKDOWN_URI, text = REPEATED_WORD_MARKDOWN) {
  driver.lsp('textDocument/didOpen', { textDocument: { uri, languageId: 'markdown', version: 0, text: '#\n' } });
  driver.lsp('textDocument/didChange', { textDocument: { uri, version: 1 }, contentChanges: [{ text }] });
  driver.timers.runPending();
}

const THREAD_PREFIX_RE = /^thread (t-[0-9a-f]{8}): /;

function threadIdOf(text) {
  const match = THREAD_PREFIX_RE.exec(text);
  return match ? match[1] : null;
}

function dispatchResult(overrides = {}) {
  return {
    verdict: 'COMMENTS',
    comments: [{ line: 3, message: 'the sentence is doing two jobs', basis: 'edit' }],
    hand: 'the document has two introductions',
    reason: null,
    ...overrides,
  };
}

function dispatchingHarness(store, respond) {
  return harness({
    store,
    dispatchConfig: { enabled: true, cooldownMs: 1 },
    dispatch: () => Promise.resolve(respond()),
  });
}

test('an accepted intent proposal is remembered as a model-stamped record tagged with the repo path', async (t) => {
  const store = fakeMemoryStore();
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  driver.wiring.applyModelIntent('shipping the memory writers', PROJECT_ID);
  await driver.wiring.whenMemoryIdle();

  assert.equal(store.appended.length, 1);
  const threadId = threadIdOf(store.appended[0].text);
  assert.equal(threadId, driver.wiring.getIntentFor(PROJECT_ID).active.id);
  assert.deepEqual(store.appended[0], {
    kind: 'intent',
    layer: 'semantic',
    project: PROJECT_PATH,
    source: { kind: 'model', vendor: 'glissa', sessionId: null },
    text: `thread ${threadId}: shipping the memory writers`,
    supersedes: null,
  });
});

test('the thread prefix passes the entropy screen, so a threaded intent enters the canon', () => {
  const { screenMemoryText } = require('../server/core/memory-core.ts');
  const screened = screenMemoryText('thread t-716d49b4: shipping the memory writers');
  assert.equal(screened.ok, true, JSON.stringify(screened));
});

test('the delivered bullet carries the thread prefix intact', () => {
  const { memoryDeliveryLines } = require('../server/core/visions-memory-core');
  const [line] = memoryDeliveryLines([{
    id: 'm-1', text: 'thread t-716d49b4: shipping the memory writers', rank: 'model', kind: 'intent',
  }]);
  assert.ok(line.includes('thread t-716d49b4: shipping the memory writers'), line);
});

test('an intent proposal that changed nothing writes nothing', async (t) => {
  const store = fakeMemoryStore();
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  driver.wiring.applyModelIntent('one statement', PROJECT_ID);
  driver.wiring.applyModelIntent('one statement', PROJECT_ID);
  await driver.wiring.whenMemoryIdle();

  assert.equal(store.appended.length, 1);
});

test('each intent record supersedes the previous one for its own project and thread', async (t) => {
  const store = fakeMemoryStore();
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  driver.wiring.applyModelIntent('first', PROJECT_ID);
  driver.wiring.applyModelIntent('unowned first', null);
  driver.wiring.applyModelIntent('second', PROJECT_ID);
  await driver.wiring.whenMemoryIdle();

  const threadId = driver.wiring.getIntentFor(PROJECT_ID).active.id;
  const unownedId = driver.wiring.getIntentFor(null).active.id;
  assert.deepEqual(store.appended.map((input) => [input.project, input.text, input.supersedes]), [
    [PROJECT_PATH, `thread ${threadId}: first`, null],
    [null, `thread ${unownedId}: unowned first`, null],
    [PROJECT_PATH, `thread ${threadId}: second`, 'm-1'],
  ]);
});

test('two threads in one project advance along two independent head chains', async (t) => {
  const store = fakeMemoryStore();
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  driver.wiring.applyModelIntent({ thread: 'new', text: 'story A' }, PROJECT_ID, MARKDOWN_URI);
  driver.wiring.applyModelIntent({ thread: 'new', text: 'story B' }, PROJECT_ID, OUTSIDE_URI);
  await driver.wiring.whenMemoryIdle();
  const threads = driver.wiring.getIntentFor(PROJECT_ID).threads;
  const storyA = threads.find((thread) => thread.text === 'story A');
  const storyB = threads.find((thread) => thread.text === 'story B');
  driver.wiring.applyModelIntent({ thread: storyA.id, text: 'story A, refined' }, PROJECT_ID, MARKDOWN_URI);
  driver.wiring.applyModelIntent({ thread: storyB.id, text: 'story B, refined' }, PROJECT_ID, OUTSIDE_URI);
  await driver.wiring.whenMemoryIdle();

  assert.deepEqual(store.appended.map((input) => [threadIdOf(input.text), input.supersedes]), [
    [storyA.id, null],
    [storyB.id, null],
    [storyA.id, 'm-1'],
    [storyB.id, 'm-2'],
  ]);
});

test('the intent chain is seeded from the loaded canon by project and thread, so a restart continues it', async (t) => {
  const store = fakeMemoryStore({
    seeded: [
      { kind: 'intent', project: PROJECT_PATH, id: 'm-old', ts: 10, text: 'thread t-716d49b4: story A' },
      { kind: 'intent', project: PROJECT_PATH, id: 'm-older', ts: 5, text: 'thread t-716d49b4: story A, older' },
      { kind: 'intent', project: PROJECT_PATH, id: 'm-other', ts: 50, text: 'thread t-0badf00d: story B' },
    ],
  });
  const intentStatePath = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'glissa-intent-')), 'visions-intent.json');
  require('node:fs').writeFileSync(intentStatePath, JSON.stringify({
    byProject: { [PROJECT_ID]: [{ id: 't-716d49b4', text: 'story A', uris: [MARKDOWN_URI], ts: FIXED_TS - 1000, hits: 1 }] },
    unowned: [],
  }));
  const driver = harness({ store, intentStatePath });
  t.after(() => driver.wiring.stop());

  driver.wiring.applyModelIntent('after a restart', PROJECT_ID, MARKDOWN_URI);
  await driver.wiring.whenMemoryIdle();

  assert.equal(threadIdOf(store.appended[0].text), 't-716d49b4');
  assert.equal(store.appended[0].supersedes, 'm-old');
});

test('an unthreaded legacy record is superseded by the next advance under its own head key, whatever the thread', async (t) => {
  const store = fakeMemoryStore({
    seeded: [
      { kind: 'intent', project: PROJECT_PATH, id: 'm-legacy', ts: 10, text: 'a statement from before threads' },
      { kind: 'intent', project: null, id: 'm-legacy-unowned', ts: 10, text: 'an unowned statement from before threads' },
    ],
  });
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  driver.wiring.applyModelIntent({ thread: 'new', text: 'story A' }, PROJECT_ID, MARKDOWN_URI);
  driver.wiring.applyModelIntent({ thread: 'new', text: 'story B' }, PROJECT_ID, OUTSIDE_URI);
  await driver.wiring.whenMemoryIdle();
  assert.deepEqual(store.appended.map((input) => input.supersedes), ['m-legacy', null], 'closed once, by the first advance, and never by a second');

  driver.wiring.applyModelIntent('the unowned story', null);
  await driver.wiring.whenMemoryIdle();
  assert.equal(store.appended.at(-1).project, null);
  assert.equal(store.appended.at(-1).supersedes, 'm-legacy-unowned', 'the null-project lineage is closed by its own next advance, not by a project');
});

test('a refused append leaves the unthreaded legacy head standing for the next advance to close', async (t) => {
  const store = fakeMemoryStore({
    refuseFirst: true,
    seeded: [{ kind: 'intent', project: PROJECT_PATH, id: 'm-legacy', ts: 10, text: 'a statement from before threads' }],
  });
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  driver.wiring.applyModelIntent({ thread: 'new', text: 'story A' }, PROJECT_ID, MARKDOWN_URI);
  driver.wiring.applyModelIntent({ thread: 'new', text: 'story B' }, PROJECT_ID, OUTSIDE_URI);
  await driver.wiring.whenMemoryIdle();

  assert.deepEqual(store.appended.map((input) => input.supersedes), ['m-legacy', 'm-legacy'],
    'a write nobody accepted spends no legacy head');
});

test('a refused intent write restarts the chain rather than naming a head that does not exist', async (t) => {
  const store = fakeMemoryStore({ refuse: true });
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  driver.wiring.applyModelIntent('first', PROJECT_ID);
  driver.wiring.applyModelIntent('second', PROJECT_ID);
  await driver.wiring.whenMemoryIdle();

  assert.deepEqual(store.appended.map((input) => input.supersedes), [null, null]);
});

test('an intent proposal with nothing to remember leaves the chain head where it was', async (t) => {
  const store = fakeMemoryStore();
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  driver.wiring.applyModelIntent('first', PROJECT_ID);
  driver.wiring.applyModelIntent('   ', PROJECT_ID);
  driver.wiring.applyModelIntent('second', PROJECT_ID);
  await driver.wiring.whenMemoryIdle();

  assert.deepEqual(store.appended.map((input) => [input.text.replace(THREAD_PREFIX_RE, ''), input.supersedes]), [
    ['first', null],
    ['second', 'm-1'],
  ]);
});

test('dispatch comments and the tier 4 hand are remembered as episodic model knowledge', async (t) => {
  const store = fakeMemoryStore();
  const driver = dispatchingHarness(store, () => dispatchResult({ intent: null }));
  t.after(() => driver.wiring.stop());

  openMarkdown(driver);
  driver.timers.runPending();
  await driver.wiring.whenDispatchSettled();
  await driver.wiring.whenMemoryIdle();

  const knowledge = store.appended.filter((input) => input.kind === 'knowledge');
  assert.deepEqual(knowledge.map((input) => [input.layer, input.source.kind, input.project, input.text]), [
    ['episodic', 'model', PROJECT_PATH, 'plan.md:3: the sentence is doing two jobs'],
    ['episodic', 'model', PROJECT_PATH, 'plan.md: the document has two introductions'],
  ]);
});

test('a dispatch result cannot stamp its own trust fields', async (t) => {
  const store = fakeMemoryStore();
  const driver = dispatchingHarness(store, () => dispatchResult({
    source: { kind: 'operator', vendor: 'claude' }, lineage: 'operator', locked: true, sig: 'forged',
  }));
  t.after(() => driver.wiring.stop());

  openMarkdown(driver);
  driver.timers.runPending();
  await driver.wiring.whenDispatchSettled();
  await driver.wiring.whenMemoryIdle();

  for (const input of store.appended) {
    assert.deepEqual(input.source, { kind: 'model', vendor: 'glissa', sessionId: null });
    assert.equal(input.locked, undefined);
    assert.equal(input.sig, undefined);
  }
});

test('a failed dispatch remembers nothing', async (t) => {
  const store = fakeMemoryStore();
  const driver = dispatchingHarness(store, () => ({ verdict: 'ERROR', comments: [], reason: 'no result file' }));
  t.after(() => driver.wiring.stop());

  openMarkdown(driver);
  driver.timers.runPending();
  await driver.wiring.whenDispatchSettled();
  await driver.wiring.whenMemoryIdle();

  assert.deepEqual(store.appended, []);
});

test('an applied tier 1 fix is remembered as action-ranked feedback, a refused one is not', async (t) => {
  const store = fakeMemoryStore();
  const driver = harness({ store, autoFix: true });
  t.after(() => driver.wiring.stop());

  openMarkdown(driver);
  const requests = driver.sent.filter((message) => message.method === 'workspace/applyEdit');
  assert.equal(requests.length, 1);
  driver.respond(requests[0].id, { applied: true });
  await driver.wiring.whenMemoryIdle();

  assert.equal(store.appended.length, 1);
  assert.deepEqual(store.appended[0].source, { kind: 'action', vendor: 'glissa', sessionId: null });
  assert.equal(store.appended[0].kind, 'feedback');
  assert.match(store.appended[0].text, /^applied repeated-word at plan\.md:\d+$/);

  driver.lsp('textDocument/didChange', {
    textDocument: { uri: MARKDOWN_URI, version: 2 },
    contentChanges: [{ text: '# Title\n\nAnother line with with a repeat.\n' }],
  });
  driver.timers.runPending();
  const refused = driver.sent.filter((message) => message.method === 'workspace/applyEdit').pop();
  driver.respond(refused.id, { applied: false });
  await driver.wiring.whenMemoryIdle();

  assert.equal(store.appended.length, 1, 'an editor refusal is not an operator verdict');
});

test('served findings are remembered once per uri and version', async (t) => {
  const store = fakeMemoryStore();
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  openMarkdown(driver);
  driver.request('ca-1', 'textDocument/codeAction', { textDocument: { uri: MARKDOWN_URI }, range: null });
  driver.request('ca-2', 'textDocument/codeAction', { textDocument: { uri: MARKDOWN_URI }, range: null });
  await driver.wiring.whenMemoryIdle();

  assert.equal(store.appended.length, 1);
  assert.equal(store.appended[0].kind, 'feedback');
  assert.deepEqual(store.appended[0].source, { kind: 'action', vendor: 'glissa', sessionId: null });
  assert.match(store.appended[0].text, /^served repeated-word@\d+:\d+ at plan\.md:\d+$/);

  driver.lsp('textDocument/didChange', {
    textDocument: { uri: MARKDOWN_URI, version: 2 },
    contentChanges: [{ text: REPEATED_WORD_MARKDOWN }],
  });
  driver.timers.runPending();
  driver.request('ca-3', 'textDocument/codeAction', { textDocument: { uri: MARKDOWN_URI }, range: null });
  await driver.wiring.whenMemoryIdle();

  assert.equal(store.appended.length, 2, 'a new buffer version is a new serving');
});

test('an explicit dismissal is remembered as action-ranked feedback', async (t) => {
  const store = fakeMemoryStore();
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  driver.lsp('visions/dismissFinding', { uri: MARKDOWN_URI, id: 'repeated-word@3:12' });
  await driver.wiring.whenMemoryIdle();

  assert.deepEqual(store.appended, [{
    kind: 'feedback',
    layer: 'episodic',
    project: PROJECT_PATH,
    source: { kind: 'action', vendor: 'glissa', sessionId: null },
    text: 'dismissed repeated-word@3:12 at plan.md',
    supersedes: null,
  }]);
});

test('a malformed or out-of-scope dismissal writes nothing and warns nobody', async (t) => {
  const store = fakeMemoryStore();
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  driver.lsp('visions/dismissFinding', null);
  driver.lsp('visions/dismissFinding', { uri: MARKDOWN_URI });
  driver.lsp('visions/dismissFinding', { id: 'repeated-word@3:12' });
  driver.lsp('visions/dismissFinding', { uri: MARKDOWN_URI, id: 42 });
  driver.lsp('visions/dismissFinding', { uri: OUTSIDE_URI, id: 'repeated-word@3:12' });
  await driver.wiring.whenMemoryIdle();

  assert.deepEqual(store.appended, []);
  assert.deepEqual(driver.warnings, []);
});

test('every writer is inert when no memory store is configured', async (t) => {
  const driver = dispatchingHarness(null, () => dispatchResult());
  t.after(() => driver.wiring.stop());

  openMarkdown(driver);
  driver.timers.runPending();
  await driver.wiring.whenDispatchSettled();
  driver.wiring.applyModelIntent('nothing to write to', PROJECT_ID);
  driver.request('ca-1', 'textDocument/codeAction', { textDocument: { uri: MARKDOWN_URI }, range: null });
  driver.lsp('visions/dismissFinding', { uri: MARKDOWN_URI, id: 'repeated-word@3:12' });
  await driver.wiring.whenMemoryIdle();

  assert.deepEqual(driver.warnings, []);
  assert.equal(driver.wiring.getIntentFor(PROJECT_ID).active.text, 'nothing to write to');
});

test('a store rejecting with a non-Error still names something in its one warning', async (t) => {
  const store = fakeMemoryStore();
  store.append = () => Promise.reject('the canon is unwritable');
  const driver = harness({ store });
  t.after(() => driver.wiring.stop());

  driver.wiring.applyModelIntent('a statement', PROJECT_ID);
  await driver.wiring.whenMemoryIdle();

  assert.deepEqual(driver.warnings, ['[visions] memory write failed: the canon is unwritable']);
});

test('a store that throws costs one warning and never reaches the relay or the dispatch path', async (t) => {
  const store = fakeMemoryStore({ throws: true });
  const driver = dispatchingHarness(store, () => dispatchResult());
  t.after(() => driver.wiring.stop());

  openMarkdown(driver);
  driver.timers.runPending();
  await driver.wiring.whenDispatchSettled();
  await driver.wiring.whenMemoryIdle();

  assert.ok(store.appended.length > 0);
  assert.ok(driver.warnings.some((message) => message.includes('memory write failed')));
  assert.equal(driver.connection.isClosed, false);

  driver.wiring.applyModelIntent('the lane keeps going', PROJECT_ID);
  await driver.wiring.whenMemoryIdle();
  assert.equal(driver.wiring.getIntentFor(PROJECT_ID).active.text, 'the lane keeps going');
});
