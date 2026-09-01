'use strict';

// M16 of docs/plan-visions-3.md: the dispatch prompt's memory section, driven through the real store so
// the delivery and the echo-suppression registry it feeds are exercised on one path. The negative half
// (a memory-off prompt is byte-identical, a throwing provider costs the section only) is pinned here too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createVisionsWiring } = require('../server/visions-wiring');
const { createMemoryStore } = require('../server/memory-store');
const { buildVisionsPrompt } = require('../server/core/visions-dispatch-core');
const { memoryInputFromEvent } = require('../server/core/memory-ingest-core.ts');
const { resolveMemoryConfig } = require('../server/core/memory-core.ts');

const PROJECT_ID = 'e1f4c0de-0000-4000-8000-000000000002';
const PROJECT_PATH = '/tmp/glissa-memory-delivery';
const MARKDOWN_URI = `file://${PROJECT_PATH}/plan.md`;
const SCOPE_PROJECTS = [{ id: PROJECT_ID, path: PROJECT_PATH }];
const BUFFER = '# Plan\n\nThe merge gate is what this section is about.\n';
const FIXED_TS = Date.UTC(2026, 7, 22, 12, 0, 0);
const RESULT_PATH = '/tmp/glissa-visions-result.json';
const QUIET = { log() {}, warn() {} };

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

function knowledge(text, project = PROJECT_PATH) {
  return {
    kind: 'knowledge',
    layer: 'semantic',
    project,
    source: { kind: 'reported', vendor: 'claude', sessionId: 'sess-1' },
    text,
  };
}

function harness(store, options = {}) {
  const timers = fakeTimers();
  const warnings = [];
  const dispatches = [];
  const wiring = createVisionsWiring({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: () => FIXED_TS,
    logger: { warn: (message) => warnings.push(message), log: () => {} },
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

async function runDispatch(driver) {
  driver.connection.handleFrame(JSON.stringify({
    type: 'lsp',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: MARKDOWN_URI, languageId: 'markdown', version: 1, text: BUFFER } },
  }));
  driver.timers.runPending();
  driver.timers.runPending();
  await driver.wiring.whenDispatchSettled();
}

async function withStore(fn, { seed = [] } = {}) {
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
  try {
    for (const input of seed) await store.append(input);
    return await fn(store);
  } finally {
    await store.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function promptOf(dispatch) {
  return buildVisionsPrompt({ ...dispatch, resultPath: RESULT_PATH });
}

test('a dispatch prompt with no memory store is byte-identical to one built without the section', async () => {
  const driver = harness(null);
  try {
    await runDispatch(driver);
    assert.equal(driver.dispatches.length, 1);
    assert.equal(driver.dispatches[0].memory, null);
    const { memory, ...withoutMemory } = driver.dispatches[0];
    assert.equal(promptOf(driver.dispatches[0]), buildVisionsPrompt({ ...withoutMemory, resultPath: RESULT_PATH }));
  } finally {
    await driver.wiring.stop();
  }
});

test('a store holding nothing relevant leaves the prompt byte-identical too', async () => {
  await withStore(async (store) => {
    const driver = harness(store);
    try {
      await runDispatch(driver);
      assert.equal(driver.dispatches[0].memory, null);
      const { memory, ...withoutMemory } = driver.dispatches[0];
      assert.equal(promptOf(driver.dispatches[0]), buildVisionsPrompt({ ...withoutMemory, resultPath: RESULT_PATH }));
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
      const { memory } = driver.dispatches[0];
      assert.equal(memory.count, 2);
      assert.equal(memory.version, manifest.version);
      const prompt = promptOf(driver.dispatches[0]);
      const marker = /GLISSA-MEMORY-[0-9A-Z-]+/.exec(prompt)[0];
      assert.equal(prompt.includes(`Long-term memory for this project (projection ${manifest.version.slice(0, 12)}): 2 recorded observation(s).`), true);
      const fenced = prompt.slice(prompt.indexOf(`<<<${marker}`), prompt.indexOf(`>>>${marker}`));
      assert.match(fenced, /the merge gate lives in session\/core\/merge-gate\.js/);
      assert.match(fenced, /the operator prefers early returns/);
      // Outside the fence: headings, counts, ids. Never a remembered byte.
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
      assert.equal(driver.dispatches[0].memory, null);
    } finally {
      await driver.wiring.stop();
    }
  }, { seed: [knowledge('the other checkout ships on fridays', '/tmp/some-other-repo')] });
});

test('a store that throws costs the prompt its memory section and nothing else', async () => {
  const store = {
    retrieve: () => { throw new Error('the canon is unreadable'); },
    noteDelivered: () => 0,
  };
  const driver = harness(store);
  try {
    await runDispatch(driver);
    assert.equal(driver.dispatches.length, 1);
    assert.equal(driver.dispatches[0].memory, null);
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
      const delivered = driver.dispatches[0].memory.text.split('\n');
      assert.equal(delivered.length, 1);
      const hashes = store.deliveredHashes();
      const event = {
        source: 'agentLogs',
        kind: 'agent-turn',
        detail: { vendor: 'claude' },
        scope: { root: PROJECT_PATH, sessionId: 'sess-echo' },
        summary: delivered[0],
        ts: FIXED_TS,
      };
      assert.equal(memoryInputFromEvent(event, { deliveredHashes: hashes }), null);
      // The same event without the registry is what the loop would have written.
      assert.notEqual(memoryInputFromEvent(event, {}), null);
    } finally {
      await driver.wiring.stop();
    }
  }, { seed: [knowledge('the merge gate lives in session/core/merge-gate.js')] });
});
