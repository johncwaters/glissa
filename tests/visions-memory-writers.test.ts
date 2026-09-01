import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createVisionsWiring } from '../server/visions-wiring.ts';
import { screenMemoryText } from '../server/core/memory-core.ts';
import { memoryDeliveryLines } from '../server/core/visions-memory-core.ts';
import type { VisionsWiringOptions } from '../server/visions-wiring.ts';

type MemoryStoreSeam = NonNullable<ReturnType<NonNullable<VisionsWiringOptions['getMemoryStore']>>>;
type DispatchOutcome = Awaited<ReturnType<NonNullable<VisionsWiringOptions['dispatch']>>>;

interface MemoryInput {
  kind: string;
  layer: string;
  project: string | null;
  source: { kind: string; vendor: string; sessionId: string | null };
  text: string;
  supersedes?: string | null;
  [field: string]: unknown;
}

function appendedAt(store: FakeMemoryStore, index: number): MemoryInput {
  const input = index < 0 ? store.appended.at(index) : store.appended[index];
  if (!input) throw new Error(`the store took no record at ${index}`);
  return input;
}

interface EditorRequest {
  id: string;
  method: string;
}

function isEditorRequest(message: unknown): message is EditorRequest {
  if (typeof message !== 'object' || message === null) return false;
  const { id, method } = message as { id?: unknown; method?: unknown };
  return typeof id === 'string' && typeof method === 'string';
}

function applyEditRequests(sent: unknown[]): EditorRequest[] {
  return sent.filter(isEditorRequest).filter((message) => message.method === 'workspace/applyEdit');
}

function threadIdOfNamed(threads: { id: string; text: string }[], text: string): string {
  const thread = threads.find((candidate) => candidate.text === text);
  if (!thread) throw new Error(`no intent thread named ${text}`);
  return thread.id;
}

const PROJECT_ID = 'e1f4c0de-0000-4000-8000-000000000001';
const PROJECT_PATH = '/tmp/glissa-memory-writers';
const MARKDOWN_URI = `file://${PROJECT_PATH}/plan.md`;
const OUTSIDE_URI = 'file:///tmp/elsewhere/plan.md';
const SCOPE_PROJECTS = [{ id: PROJECT_ID, path: PROJECT_PATH }];
const REPEATED_WORD_MARKDOWN = '# Title\n\nA line with with a repeat.\n';
const FIXED_TS = 1700000000000;

function fakeTimers() {
  const pendingByHandle = new Map<NodeJS.Timeout, () => void>();
  return {
    setTimeoutFn: (fn: () => void): NodeJS.Timeout => {
      const handle = setTimeout(() => {}, 2 ** 30);
      handle.unref();
      pendingByHandle.set(handle, fn);
      return handle;
    },
    clearTimeoutFn: (handle: NodeJS.Timeout) => {
      clearTimeout(handle);
      pendingByHandle.delete(handle);
    },
    runPending: () => {
      const jobs = [...pendingByHandle.values()];
      for (const handle of pendingByHandle.keys()) clearTimeout(handle);
      pendingByHandle.clear();
      for (const job of jobs) job();
    },
  };
}

type FakeMemoryStore = MemoryStoreSeam & { appended: MemoryInput[] };

function fakeMemoryStore({
  refuse = false, refuseFirst = false, throws = false, seeded = [],
}: { refuse?: boolean; refuseFirst?: boolean; throws?: boolean; seeded?: object[] } = {}): FakeMemoryStore {
  const appended: MemoryInput[] = [];
  let minted = 0;
  return {
    appended,
    records: () => seeded.slice(),
    append(input: object) {
      appended.push(input as MemoryInput);
      if (throws) return Promise.reject(new Error('the canon is unwritable'));
      if (refuse || (refuseFirst && appended.length === 1)) return Promise.resolve(null);
      minted += 1;
      return Promise.resolve({ ...input, id: `m-${minted}` });
    },
  };
}

function harness({ store = null, ...options }: VisionsWiringOptions & { store?: MemoryStoreSeam | null } = {}) {
  const timers = fakeTimers();
  const warnings: string[] = [];
  const sent: unknown[] = [];
  const wiring = createVisionsWiring({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: () => FIXED_TS,
    logger: { warn: (message: string) => { warnings.push(message); }, log: () => {} },
    scopeProjects: SCOPE_PROJECTS,
    getMemoryStore: store ? () => store : null,
    ...options,
  });
  const connection = wiring.openConnection({ send: (message) => { sent.push(message); } });
  return {
    wiring,
    connection,
    timers,
    warnings,
    sent,
    lsp: (method: string, params: unknown) => connection.handleFrame(JSON.stringify({ type: 'lsp', method, params })),
    request: (id: string, method: string, params: unknown) => connection.handleFrame(JSON.stringify({
      type: 'lsp-request', id, method, params,
    })),
    respond: (id: string, result: unknown) => connection.handleFrame(JSON.stringify({ type: 'lsp-response', id, result })),
  };
}

function openMarkdown(driver: ReturnType<typeof harness>, uri = MARKDOWN_URI, text = REPEATED_WORD_MARKDOWN): void {
  driver.lsp('textDocument/didOpen', { textDocument: { uri, languageId: 'markdown', version: 0, text: '#\n' } });
  driver.lsp('textDocument/didChange', { textDocument: { uri, version: 1 }, contentChanges: [{ text }] });
  driver.timers.runPending();
}

const THREAD_PREFIX_RE = /^thread (t-[0-9a-f]{8}): /;

function threadIdOf(text: string): string | null {
  const match = THREAD_PREFIX_RE.exec(text);
  return match ? match[1] : null;
}

function dispatchResult(overrides: Partial<DispatchOutcome> = {}): DispatchOutcome {
  return {
    verdict: 'COMMENTS',
    comments: [{ line: 3, message: 'the sentence is doing two jobs', basis: 'edit' }],
    hand: 'the document has two introductions',
    reason: null,
    ...overrides,
  };
}

function dispatchingHarness(store: MemoryStoreSeam | null, respond: () => DispatchOutcome) {
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
  const threadId = threadIdOf(appendedAt(store, 0).text);
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
  const screened = screenMemoryText('thread t-716d49b4: shipping the memory writers');
  assert.equal(screened.ok, true, JSON.stringify(screened));
});

test('the delivered bullet carries the thread prefix intact', () => {
  const [line] = memoryDeliveryLines([{
    id: 'm-1', text: 'thread t-716d49b4: shipping the memory writers', rank: 'model', kind: 'intent',
  }]);
  assert.ok(line?.includes('thread t-716d49b4: shipping the memory writers'), line);
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
  const storyA = threadIdOfNamed(threads, 'story A');
  const storyB = threadIdOfNamed(threads, 'story B');
  driver.wiring.applyModelIntent({ thread: storyA, text: 'story A, refined' }, PROJECT_ID, MARKDOWN_URI);
  driver.wiring.applyModelIntent({ thread: storyB, text: 'story B, refined' }, PROJECT_ID, OUTSIDE_URI);
  await driver.wiring.whenMemoryIdle();

  assert.deepEqual(store.appended.map((input) => [threadIdOf(input.text), input.supersedes]), [
    [storyA, null],
    [storyB, null],
    [storyA, 'm-1'],
    [storyB, 'm-2'],
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
  const intentStatePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-intent-')), 'visions-intent.json');
  fs.writeFileSync(intentStatePath, JSON.stringify({
    byProject: { [PROJECT_ID]: [{ id: 't-716d49b4', text: 'story A', uris: [MARKDOWN_URI], ts: FIXED_TS - 1000, hits: 1 }] },
    unowned: [],
  }));
  const driver = harness({ store, intentStatePath });
  t.after(() => driver.wiring.stop());

  driver.wiring.applyModelIntent('after a restart', PROJECT_ID, MARKDOWN_URI);
  await driver.wiring.whenMemoryIdle();

  assert.equal(threadIdOf(appendedAt(store, 0).text), 't-716d49b4');
  assert.equal(appendedAt(store, 0).supersedes, 'm-old');
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
  assert.equal(appendedAt(store, -1).project, null);
  assert.equal(appendedAt(store, -1).supersedes, 'm-legacy-unowned', 'the null-project lineage is closed by its own next advance, not by a project');
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

  const driver = dispatchingHarness(store, () => ({
    ...dispatchResult(),
    source: { kind: 'operator', vendor: 'claude' },
    lineage: 'operator',
    locked: true,
    sig: 'forged',
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
  const requests = applyEditRequests(driver.sent);
  assert.equal(requests.length, 1);
  driver.respond(String(requests[0]?.id), { applied: true });
  await driver.wiring.whenMemoryIdle();

  assert.equal(store.appended.length, 1);
  assert.deepEqual(appendedAt(store, 0).source, { kind: 'action', vendor: 'glissa', sessionId: null });
  assert.equal(appendedAt(store, 0).kind, 'feedback');
  assert.match(appendedAt(store, 0).text, /^applied repeated-word at plan\.md:\d+$/);

  driver.lsp('textDocument/didChange', {
    textDocument: { uri: MARKDOWN_URI, version: 2 },
    contentChanges: [{ text: '# Title\n\nAnother line with with a repeat.\n' }],
  });
  driver.timers.runPending();
  const refused = applyEditRequests(driver.sent).pop();
  assert.ok(refused, 'a second applyEdit was requested');
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
  assert.equal(appendedAt(store, 0).kind, 'feedback');
  assert.deepEqual(appendedAt(store, 0).source, { kind: 'action', vendor: 'glissa', sessionId: null });
  assert.match(appendedAt(store, 0).text, /^served repeated-word@\d+:\d+ at plan\.md:\d+$/);

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
