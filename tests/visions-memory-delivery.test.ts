import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createVisionsWiring } from '../server/visions-wiring.ts';
import type { VisionsWiringOptions } from '../server/visions-wiring.ts';
import { createMemoryStore } from '../server/memory-store.ts';
import { buildVisionsPrompt } from '../server/core/visions-dispatch-core.ts';
import { memoryInputFromEvent } from '../server/core/memory-ingest-core.ts';
import { resolveMemoryConfig } from '../server/core/memory-core.ts';

type MemoryStore = NonNullable<ReturnType<typeof createMemoryStore>>;
type MemoryStoreSeam = ReturnType<NonNullable<VisionsWiringOptions['getMemoryStore']>>;
type DispatchFn = NonNullable<VisionsWiringOptions['dispatch']>;
type DispatchArgs = Parameters<DispatchFn>[0];

function memoryOf(dispatch: DispatchArgs): { text: string; count: number; version: string | null } {
  const { memory } = dispatch;
  if (!memory) throw new Error('the dispatch carried no memory section');
  return memory;
}

function dispatchAt(dispatches: DispatchArgs[], index: number): DispatchArgs {
  const dispatch = dispatches[index];
  if (!dispatch) throw new Error(`no dispatch at ${index}`);
  return dispatch;
}

const PROJECT_ID = 'e1f4c0de-0000-4000-8000-000000000002';
const PROJECT_PATH = '/tmp/glissa-memory-delivery';
const MARKDOWN_URI = `file://${PROJECT_PATH}/plan.md`;
const SCOPE_PROJECTS = [{ id: PROJECT_ID, path: PROJECT_PATH }];
const BUFFER = '# Plan\n\nThe merge gate is what this section is about.\n';
const FIXED_TS = Date.UTC(2026, 7, 22, 12, 0, 0);
const RESULT_PATH = '/tmp/glissa-visions-result.json';
const QUIET = { log() {}, warn() {} };

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

function knowledge(text: string, project: string | null = PROJECT_PATH) {
  return {
    kind: 'knowledge',
    layer: 'semantic',
    project,
    source: { kind: 'reported', vendor: 'claude', sessionId: 'sess-1' },
    text,
  };
}

function harness(store: MemoryStoreSeam, options: VisionsWiringOptions = {}) {
  const timers = fakeTimers();
  const warnings: string[] = [];
  const dispatches: DispatchArgs[] = [];
  const wiring = createVisionsWiring({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: () => FIXED_TS,
    logger: { warn: (message: string) => { warnings.push(message); }, log: () => {} },
    scopeProjects: SCOPE_PROJECTS,
    getMemoryStore: store ? () => store : null,
    dispatchConfig: { enabled: true, cooldownMs: 1 },
    dispatch: (args) => {
      dispatches.push(args);
      return Promise.resolve({ verdict: 'NONE', comments: [], reason: null });
    },
    ...options,
  });
  const connection = wiring.openConnection({ send: () => {} });
  return { wiring, connection, timers, warnings, dispatches };
}

async function runDispatch(driver: { connection: { handleFrame: (raw: string) => void }; timers: ReturnType<typeof fakeTimers>; wiring: { whenDispatchSettled: () => Promise<unknown> } }): Promise<void> {
  driver.connection.handleFrame(JSON.stringify({
    type: 'lsp',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: MARKDOWN_URI, languageId: 'markdown', version: 1, text: BUFFER } },
  }));
  driver.timers.runPending();
  driver.timers.runPending();
  await driver.wiring.whenDispatchSettled();
}

async function withStore<T>(fn: (store: MemoryStore) => Promise<T>, { seed = [] }: { seed?: object[] } = {}): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-delivery-'));
  let clock = FIXED_TS;
  const store = createMemoryStore({
    dir,
    dbPath: path.join(dir, 'glissa.db'),
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: QUIET,
    now: () => clock++,
    projectionDebounceMs: 5,
  });
  if (!store) throw new Error('the memory store refused to open');
  try {
    for (const input of seed) await store.append(input);
    return await fn(store);
  } finally {
    await store.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function promptOf(dispatch: DispatchArgs): string {
  return buildVisionsPrompt({ ...dispatch, resultPath: RESULT_PATH });
}

test('a dispatch prompt with no memory store is byte-identical to one built without the section', async () => {
  const driver = harness(null);
  try {
    await runDispatch(driver);
    assert.equal(driver.dispatches.length, 1);
    assert.equal(dispatchAt(driver.dispatches, 0).memory, null);
    const { memory, ...withoutMemory } = dispatchAt(driver.dispatches, 0);
    assert.equal(promptOf(dispatchAt(driver.dispatches, 0)), buildVisionsPrompt({ ...withoutMemory, resultPath: RESULT_PATH }));
  } finally {
    await driver.wiring.stop();
  }
});

test('a store holding nothing relevant leaves the prompt byte-identical too', async () => {
  await withStore(async (store) => {
    const driver = harness(store);
    try {
      await runDispatch(driver);
      assert.equal(dispatchAt(driver.dispatches, 0).memory, null);
      const { memory, ...withoutMemory } = dispatchAt(driver.dispatches, 0);
      assert.equal(promptOf(dispatchAt(driver.dispatches, 0)), buildVisionsPrompt({ ...withoutMemory, resultPath: RESULT_PATH }));
    } finally {
      await driver.wiring.stop();
    }
  });
});

test('records for the active project and the global layer ride in their own fence, naming the projection version', async () => {
  await withStore(async (store) => {
    await store.flushProjection();
    const manifest = await store.readPublishedManifest();
    const driver = harness(store);
    try {
      await runDispatch(driver);
      const memory = memoryOf(dispatchAt(driver.dispatches, 0));
      assert.ok(manifest?.version, 'the projection published a version');
      assert.equal(memory.count, 2);
      assert.equal(memory.version, manifest.version);
      const prompt = promptOf(dispatchAt(driver.dispatches, 0));
      const marker = /GLISSA-MEMORY-[0-9A-Z-]+/.exec(prompt)?.[0];
      assert.ok(marker, 'the prompt fenced the memory section');
      assert.equal(prompt.includes(`Long-term memory for this project (projection ${manifest.version.slice(0, 12)}): 2 recorded observation(s).`), true);
      const fenced = prompt.slice(prompt.indexOf(`<<<${marker}`), prompt.indexOf(`>>>${marker}`));
      assert.match(fenced, /the merge gate lives in session\/core\/merge-gate\.js/);
      assert.match(fenced, /the operator prefers early returns/);

      const outside = prompt.replace(fenced, '').replace(`>>>${marker}`, '');
      assert.equal(outside.includes('the merge gate lives in'), false);
      assert.equal(outside.includes('BUFFER'), true);
    } finally {
      await driver.wiring.stop();
    }
  }, {
    seed: [
      knowledge('the merge gate lives in session/core/merge-gate.js'),
      knowledge('the operator prefers early returns', null),
    ],
  });
});

test('another project\'s records never reach this project\'s prompt', async () => {
  await withStore(async (store) => {
    const driver = harness(store);
    try {
      await runDispatch(driver);
      assert.equal(dispatchAt(driver.dispatches, 0).memory, null);
    } finally {
      await driver.wiring.stop();
    }
  }, { seed: [knowledge('the other checkout ships on fridays', '/tmp/some-other-repo')] });
});

test('a store that throws costs the prompt its memory section and nothing else', async () => {
  const store: MemoryStoreSeam = {
    append: async () => null,
    retrieve: () => { throw new Error('the canon is unreadable'); },
    noteDelivered: () => {},
  };
  const driver = harness(store);
  try {
    await runDispatch(driver);
    assert.equal(driver.dispatches.length, 1);
    assert.equal(dispatchAt(driver.dispatches, 0).memory, null);
    assert.equal(driver.warnings.some((line) => line.includes('memory retrieval failed')), true);
  } finally {
    await driver.wiring.stop();
  }
});

test('every delivered line is registered, so the feedback loop closes: a session quoting it back is not re-ingested', async () => {
  await withStore(async (store) => {
    const driver = harness(store);
    try {
      await runDispatch(driver);
      const delivered = memoryOf(dispatchAt(driver.dispatches, 0)).text.split('\n');
      assert.equal(delivered.length, 1);
      const hashes = store.deliveredHashes();
      const event = {
        source: 'agentLogs',
        kind: 'agent-turn',
        detail: { vendor: 'claude' },
        scope: { root: PROJECT_PATH, sessionId: 'sess-echo' },
        summary: String(delivered[0]),
        ts: FIXED_TS,
      };
      assert.equal(memoryInputFromEvent(event, { deliveredHashes: hashes }), null);

      assert.notEqual(memoryInputFromEvent(event, {}), null);
    } finally {
      await driver.wiring.stop();
    }
  }, { seed: [knowledge('the merge gate lives in session/core/merge-gate.js')] });
});
