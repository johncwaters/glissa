'use strict';

// Intent threads (docs/plan-visions-4-focus.md, M20): several live statements per project, bound to the
// uris they were advanced on, retiring on read, with a legacy slot file lifting into one thread each.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_THREAD_TTL_MS,
  MAX_INTENT_CHARS,
  MAX_THREADS_PER_PROJECT,
  THREAD_ID_RE,
  activeThreadFor,
  applyModelIntent,
  createIntentState,
  intentPayload,
  intentProjectPayload,
  isEmptyIntent,
  liveThreadsFor,
  pruneIntentProjects,
  readIntentProposal,
  retireStaleThreads,
  reviveIntentState,
  sanitizeIntentText,
} = require('../server/core/visions-intent-core');

const NOW = 1700000000000;
const PROJECT = 'e1f4c0de-0000-4000-8000-000000000001';
const OTHER_PROJECT = 'e1f4c0de-0000-4000-8000-000000000002';
const URI = 'file:///tmp/plan.md';
const OTHER_URI = 'file:///tmp/other.md';

function open(state, text, { now = NOW, projectId = PROJECT, uri = URI } = {}) {
  return applyModelIntent(state, {
    intent: { thread: 'new', text }, now, projectId, uri,
  });
}

test('the initial state has no thread anywhere', () => {
  const state = createIntentState();
  assert.equal(isEmptyIntent(state), true);
  assert.equal(activeThreadFor(state, null), null);
  assert.equal(activeThreadFor(state, PROJECT, URI), null);
  assert.deepEqual(intentPayload(state), { byProject: {}, unowned: [] });
});

test('a string proposal opens a thread when the project has none, with a server-minted id', () => {
  const { state, changed, thread } = applyModelIntent(createIntentState(), {
    intent: 'refactor of the spawn path', now: NOW, projectId: PROJECT, uri: URI,
  });
  assert.equal(changed, true);
  assert.match(thread.id, THREAD_ID_RE);
  assert.deepEqual(thread, {
    id: thread.id, text: 'refactor of the spawn path', uris: [URI], ts: NOW, hits: 1,
  });
  assert.deepEqual(activeThreadFor(state, PROJECT, URI), thread);
  assert.equal(isEmptyIntent(state), false);
});

test('a string proposal advances the active thread rather than opening a second one', () => {
  const first = open(createIntentState(), 'first belief').state;
  const { state, changed, thread } = applyModelIntent(first, {
    intent: 'second belief', now: NOW + 1000, projectId: PROJECT, uri: OTHER_URI,
  });
  assert.equal(changed, true);
  assert.equal(liveThreadsFor(state, PROJECT).length, 1);
  assert.deepEqual(thread, {
    id: first.byProject[PROJECT][0].id, text: 'second belief', uris: [URI, OTHER_URI], ts: NOW + 1000, hits: 2,
  });
});

test('the same text on a uri the thread already holds is not a change', () => {
  const first = open(createIntentState(), 'same belief').state;
  const again = applyModelIntent(first, {
    intent: 'same belief', now: NOW + 60000, projectId: PROJECT, uri: URI,
  });
  assert.equal(again.changed, false);
  assert.equal(again.state, first);
  const onNewUri = applyModelIntent(first, {
    intent: 'same belief', now: NOW + 60000, projectId: PROJECT, uri: OTHER_URI,
  });
  assert.equal(onNewUri.changed, true, 'binding a new uri is a change even with the text standing');
});

test('the object form names a thread to advance or opens a new one, and an unknown id is refused', () => {
  const first = open(createIntentState(), 'story A').state;
  const second = open(first, 'story B', { now: NOW + 1, uri: OTHER_URI }).state;
  assert.equal(liveThreadsFor(second, PROJECT).length, 2);
  const [idA] = first.byProject[PROJECT].map((thread) => thread.id);

  const advanced = applyModelIntent(second, {
    intent: { thread: idA, text: 'story A, refined' }, now: NOW + 2, projectId: PROJECT, uri: URI,
  });
  assert.equal(advanced.changed, true);
  assert.equal(advanced.thread.id, idA);
  assert.equal(advanced.thread.text, 'story A, refined');

  const refused = applyModelIntent(second, {
    intent: { thread: 't-00000000', text: 'nobody' }, now: NOW + 3, projectId: PROJECT, uri: URI,
  });
  assert.deepEqual(refused, {
    state: second, changed: false, thread: null, refused: 'unknown-thread',
  });
  for (const thread of ['new-ish', 'T-00000000', 't-0000000', 't-00000000a', 42]) {
    assert.equal(readIntentProposal({ thread, text: 'x' }), null, `${JSON.stringify(thread)} is not an accepted thread`);
  }
  assert.equal(readIntentProposal({ text: 'x' }), null, 'an object naming no thread at all is not a proposal');
});

// The lane reads a proposal twice: once off the result file, once again in the wiring that merges it.
test('an already-parsed proposal reads back as itself, an explicit null thread meaning the active one', () => {
  assert.deepEqual(readIntentProposal(readIntentProposal('  a plain string  ')), { thread: null, text: 'a plain string' });
  assert.deepEqual(readIntentProposal({ thread: null, text: 'the active thread' }), { thread: null, text: 'the active thread' });
  assert.deepEqual(readIntentProposal(readIntentProposal({ thread: 'new', text: 'a second story' })), { thread: 'new', text: 'a second story' });
});

test('the thread id shape has one definition, which the intent core builds its regex from', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { VISIONS_THREAD_ID_PATTERN } = require('../shared/visions-intent-ids.ts');
  const { THREAD_ID_PATTERN } = require('../server/core/visions-intent-core');
  assert.equal(THREAD_ID_PATTERN, VISIONS_THREAD_ID_PATTERN);
  assert.equal(THREAD_ID_RE.source, `^${VISIONS_THREAD_ID_PATTERN}$`);
  const restated = /\/\^?t-\[0-9a-f\]\{8\}/;
  for (const file of ['server/core/visions-intent-core.js', 'server/core/visions-memory-core.js', 'server/core/visions-dispatch-core.js', 'public/visions-view-core.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.equal(restated.test(source), false, `${file} must build the id shape from the shared pattern, not restate it`);
  }
  const browserCore = fs.readFileSync(path.join(__dirname, '..', 'public/visions-view-core.mjs'), 'utf8');
  assert.match(browserCore, /import \{ VISIONS_THREAD_ID_PATTERN \} from '#shared\/visions-intent-ids\.ts';/);
});

test('selection prefers the thread bound to this uri, then recency, then hits', () => {
  let state = open(createIntentState(), 'older story', { now: NOW, uri: URI }).state;
  state = open(state, 'newer story', { now: NOW + 1000, uri: OTHER_URI }).state;
  assert.equal(activeThreadFor(state, PROJECT, URI).text, 'older story', 'the uri binding wins over age');
  assert.equal(activeThreadFor(state, PROJECT, OTHER_URI).text, 'newer story');
  assert.equal(activeThreadFor(state, PROJECT, 'file:///tmp/unbound.md').text, 'newer story', 'an unbound uri reads the newest');
  assert.equal(activeThreadFor(state, PROJECT, null).text, 'newer story');

  const tied = {
    byProject: {
      [PROJECT]: [
        { id: 't-aaaaaaaa', text: 'one hit', uris: [], ts: NOW, hits: 1 },
        { id: 't-bbbbbbbb', text: 'three hits', uris: [], ts: NOW, hits: 3 },
      ],
    },
    unowned: [],
  };
  assert.equal(activeThreadFor(tied, PROJECT, URI).text, 'three hits');
});

test('an unowned thread never reaches a project, and a project with no thread delivers nothing', () => {
  const unowned = applyModelIntent(createIntentState(), { intent: 'the machine-wide belief', now: NOW, projectId: null }).state;
  assert.equal(activeThreadFor(unowned, null).text, 'the machine-wide belief');
  assert.equal(activeThreadFor(unowned, PROJECT, URI), null, 'the slot model leaked this text into projects; threads do not');
  assert.deepEqual(intentProjectPayload(unowned, PROJECT), { active: null, threads: [] });
});

test('the cap is five live threads per project, and the oldest retires when a sixth opens', () => {
  let state = createIntentState();
  for (let index = 0; index < MAX_THREADS_PER_PROJECT + 1; index += 1) {
    state = open(state, `story ${index}`, { now: NOW + index, uri: `${URI}#${index}` }).state;
  }
  const texts = liveThreadsFor(state, PROJECT).map((thread) => thread.text);
  assert.equal(texts.length, MAX_THREADS_PER_PROJECT);
  assert.equal(texts.includes('story 0'), false);
  assert.equal(texts[0], `story ${MAX_THREADS_PER_PROJECT}`, 'newest first');
});

test('a thread untouched for the ttl retires on read, and the rest stand', () => {
  let state = open(createIntentState(), 'stale', { now: NOW }).state;
  state = open(state, 'fresh', { now: NOW + DEFAULT_THREAD_TTL_MS, uri: OTHER_URI }).state;
  state = applyModelIntent(state, { intent: 'unowned stale', now: NOW, projectId: null }).state;
  const untouched = retireStaleThreads(state, { now: NOW + DEFAULT_THREAD_TTL_MS });
  assert.equal(untouched.changed, false);
  assert.equal(untouched.state, state);

  assert.deepEqual(untouched.projects, []);

  const retired = retireStaleThreads(state, { now: NOW + DEFAULT_THREAD_TTL_MS + 1 });
  assert.equal(retired.changed, true);
  assert.deepEqual(retired.projects, [PROJECT, null], 'the keys whose list shrank, unowned as null, so no caller re-derives them');
  assert.deepEqual(liveThreadsFor(retired.state, PROJECT).map((thread) => thread.text), ['fresh']);
  assert.deepEqual(retired.state.unowned, []);

  const shortTtl = retireStaleThreads(state, { now: NOW + DEFAULT_THREAD_TTL_MS + 5000, ttlMs: 1000 });
  assert.equal(isEmptyIntent(shortTtl.state), true);
});

test('text is trimmed, capped, and strings only', () => {
  assert.equal(sanitizeIntentText('  padded  '), 'padded');
  assert.equal(sanitizeIntentText('a plan\n- a forged rule\r\nand more'), 'a plan - a forged rule and more');
  assert.equal(sanitizeIntentText('a plan\u0000\u200b tail'), 'a plan tail');
  assert.equal(sanitizeIntentText(`${'x'.repeat(MAX_INTENT_CHARS)}\nforged`).length, MAX_INTENT_CHARS, 'the collapse happens before the cap');
  const { sanitizeOneLine } = require('../server/core/text-core');
  assert.equal(sanitizeIntentText('a plan\n- a forged rule\u0000'), sanitizeOneLine('a plan\n- a forged rule\u0000', MAX_INTENT_CHARS),
    'one normalizer behind both cores, never two copies of the rule');
  assert.equal(sanitizeIntentText(12345), '');
  assert.equal(sanitizeIntentText(null), '');
  const long = 'x'.repeat(MAX_INTENT_CHARS + 120);
  assert.equal(sanitizeIntentText(long).length, MAX_INTENT_CHARS);
  assert.equal(open(createIntentState(), long).thread.text.length, MAX_INTENT_CHARS);
  for (const empty of ['', '   ', null, undefined, 42, ['x'], { text: '' }, { thread: 'new' }]) {
    assert.deepEqual(applyModelIntent(createIntentState(), { intent: empty, now: NOW, projectId: PROJECT }), {
      state: createIntentState(), changed: false, thread: null, refused: null,
    });
  }
});

test('a thread keeps only its newest uris, and never one too long to be a document', () => {
  const longUri = `file:///tmp/${'a'.repeat(2100)}.md`;
  let state = open(createIntentState(), 'a story', { uri: `${URI}#0` }).state;
  for (let index = 1; index <= 25; index += 1) {
    state = applyModelIntent(state, {
      intent: 'a story, refined', now: NOW + index, projectId: PROJECT, uri: `${URI}#${index}`,
    }).state;
  }
  const [thread] = liveThreadsFor(state, PROJECT);
  assert.equal(thread.uris.length, 20);
  assert.equal(thread.uris[0], `${URI}#6`, 'the newest twenty, oldest dropped');
  assert.equal(thread.uris.at(-1), `${URI}#25`);

  const withLongUri = applyModelIntent(state, {
    intent: 'a story, refined again', now: NOW + 26, projectId: PROJECT, uri: longUri,
  }).state;
  assert.equal(liveThreadsFor(withLongUri, PROJECT)[0].uris.includes(longUri), false);

  const opened = open(createIntentState(), 'a story', { uri: longUri });
  assert.deepEqual(opened.thread.uris, []);
  let repeated = opened.state;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const again = applyModelIntent(repeated, {
      intent: 'a story', now: NOW + attempt + 1, projectId: PROJECT, uri: longUri,
    });
    assert.equal(again.changed, false, 'a uri no thread can store never makes an identical proposal a change');
    assert.equal(again.thread.hits, 1);
    repeated = again.state;
  }
  assert.deepEqual(reviveIntentState({
    byProject: {}, unowned: [{ id: 't-aaaaaaaa', text: 'unowned', uris: [longUri, ...Array.from({ length: 30 }, (_, index) => `${URI}#${index}`)], ts: NOW }],
  }).unowned[0].uris, Array.from({ length: 20 }, (_, index) => `${URI}#${index + 10}`));
});

test('a persisted thread state revives with sanitized threads and minted ids kept', () => {
  const stored = {
    byProject: {
      [PROJECT]: [
        { id: 't-716d49b4', text: '  a story  ', uris: [URI, 7, URI], ts: NOW, hits: 4 },
        { id: 'not-an-id', text: 'dropped', uris: [], ts: NOW, hits: 1 },
        { id: 't-716d49b4', text: 'duplicate id dropped', uris: [], ts: NOW, hits: 1 },
      ],
    },
    unowned: [{ id: 't-aaaaaaaa', text: 'unowned', ts: -1 }],
  };
  assert.deepEqual(reviveIntentState(stored), {
    byProject: {
      [PROJECT]: [{
        id: 't-716d49b4', text: 'a story', uris: [URI], ts: NOW, hits: 4,
      }],
    },
    unowned: [],
  });
});

test('both legacy slot shapes lift into one thread each, so an upgrade keeps the statement', () => {
  const flat = reviveIntentState({ text: '  durable operator statement  ', source: 'operator', locked: true, ts: NOW });
  assert.equal(flat.unowned.length, 1);
  assert.match(flat.unowned[0].id, THREAD_ID_RE);
  assert.deepEqual(flat.unowned[0], {
    id: flat.unowned[0].id, text: 'durable operator statement', uris: [], ts: NOW, hits: 1,
  });
  assert.deepEqual(reviveIntentState({ text: 'durable operator statement', source: 'model', ts: NOW }), flat, 'the same slot lifts to the same id');

  const scoped = reviveIntentState({
    global: { text: 'the global belief', source: 'model', ts: NOW },
    byProject: {
      [PROJECT]: { text: 'this project only', source: 'model' },
      [OTHER_PROJECT]: { text: 'no domain', source: 'system', ts: NOW },
    },
  });
  assert.deepEqual(Object.keys(scoped.byProject), [PROJECT]);
  assert.equal(scoped.byProject[PROJECT][0].text, 'this project only');
  assert.equal(scoped.byProject[PROJECT][0].ts, 0);
  assert.equal(scoped.unowned[0].text, 'the global belief');
  assert.equal(activeThreadFor(scoped, OTHER_PROJECT, URI), null, 'the lifted global text stays unowned');
});

test('revival never throws on junk persisted values', () => {
  for (const raw of [null, undefined, 42, true, [], ['text'], 'intent', { byProject: 7 }, { byProject: ['x'] }, { unowned: 'x' }]) {
    assert.doesNotThrow(() => reviveIntentState(raw));
    assert.deepEqual(reviveIntentState(raw), createIntentState());
  }
});

test('a project id the config no longer knows is pruned, and an unsupplied list prunes nothing', () => {
  const stored = {
    byProject: {
      [PROJECT]: [{ id: 't-11111111', text: 'still configured', uris: [], ts: NOW, hits: 1 }],
      [OTHER_PROJECT]: [{ id: 't-22222222', text: 'deleted project', uris: [], ts: NOW, hits: 1 }],
    },
    unowned: [{ id: 't-33333333', text: 'unowned survives', uris: [], ts: NOW, hits: 1 }],
  };
  assert.deepEqual(Object.keys(reviveIntentState(stored, { projectIds: [PROJECT] }).byProject), [PROJECT]);
  const kept = reviveIntentState(stored);
  assert.deepEqual(Object.keys(kept.byProject).sort(), [PROJECT, OTHER_PROJECT].sort());
  assert.equal(pruneIntentProjects(kept, null), kept, 'no list is no pruning, not an empty list');
  assert.deepEqual(pruneIntentProjects(kept, []).byProject, {});
  assert.equal(pruneIntentProjects(kept, []).unowned.length, 1);
  assert.equal(isEmptyIntent(pruneIntentProjects(kept, [])), false);
});

test('the payloads are copies carrying exactly the wire fields, active first', () => {
  let state = open(createIntentState(), 'older', { now: NOW, uri: URI }).state;
  state = open(state, 'newer', { now: NOW + 1, uri: OTHER_URI }).state;
  const perProject = intentProjectPayload(state, PROJECT, URI);
  assert.equal(perProject.active.text, 'older');
  assert.deepEqual(perProject.threads.map((thread) => thread.text), ['older', 'newer']);
  perProject.active.text = 'mutated';
  perProject.threads[1].uris.push('file:///x');
  assert.equal(activeThreadFor(state, PROJECT, URI).text, 'older');
  assert.deepEqual(liveThreadsFor(state, PROJECT)[0].uris, [OTHER_URI]);

  const whole = intentPayload(state);
  assert.deepEqual(whole.byProject[PROJECT].map((thread) => thread.text), ['newer', 'older']);
  assert.deepEqual(whole.unowned, []);
  assert.deepEqual(intentPayload(null), { byProject: {}, unowned: [] });
});
