'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_INTENT_CHARS,
  applyModelIntent,
  createIntentSlot,
  createIntentState,
  intentPayload,
  intentSlotFor,
  intentTextFor,
  isEmptyIntent,
  pruneIntentProjects,
  reviveIntentState,
  sanitizeIntentText,
} = require('../server/core/visions-intent-core');

const NOW = 1700000000000;
const PROJECT = 'e1f4c0de-0000-4000-8000-000000000001';
const OTHER_PROJECT = 'e1f4c0de-0000-4000-8000-000000000002';

test('the initial state has no statement anywhere', () => {
  const state = createIntentState();
  assert.deepEqual(state, { global: null, byProject: {} });
  assert.equal(isEmptyIntent(state), true);
  assert.equal(intentSlotFor(state, null), null);
  assert.equal(intentSlotFor(state, PROJECT), null);
});

test('a model proposal with no project lands on the global slot', () => {
  const { state, changed } = applyModelIntent(createIntentState(), { text: 'refactor of the spawn path', now: NOW });
  assert.equal(changed, true);
  assert.deepEqual(state, {
    global: { text: 'refactor of the spawn path', source: 'model', ts: NOW },
    byProject: {},
  });
});

test('a model proposal with a project lands on that project and leaves the others alone', () => {
  const first = applyModelIntent(createIntentState(), { text: 'the global belief', now: NOW }).state;
  const { state, changed } = applyModelIntent(first, { text: 'what this repo is for', now: NOW + 1000, projectId: PROJECT });
  assert.equal(changed, true);
  assert.deepEqual(state, {
    global: { text: 'the global belief', source: 'model', ts: NOW },
    byProject: { [PROJECT]: { text: 'what this repo is for', source: 'model', ts: NOW + 1000 } },
  });

  const second = applyModelIntent(state, { text: 'a different repo', now: NOW + 2000, projectId: OTHER_PROJECT }).state;
  assert.equal(second.byProject[PROJECT].text, 'what this repo is for');
  assert.equal(second.byProject[OTHER_PROJECT].text, 'a different repo');
  assert.equal(second.global.text, 'the global belief');
});

test('a model proposal replaces the standing statement in its own slot', () => {
  const first = applyModelIntent(createIntentState(), { text: 'first belief', now: NOW, projectId: PROJECT }).state;
  const { state, changed } = applyModelIntent(first, { text: 'second belief', now: NOW + 1000, projectId: PROJECT });
  assert.equal(changed, true);
  assert.deepEqual(state.byProject[PROJECT], {
    text: 'second belief', source: 'model', ts: NOW + 1000,
  });
});

test('a model proposal of the same statement changes nothing', () => {
  const first = applyModelIntent(createIntentState(), { text: 'same belief', now: NOW, projectId: PROJECT }).state;
  const again = applyModelIntent(first, { text: 'same belief', now: NOW + 60000, projectId: PROJECT });
  assert.equal(again.changed, false);
  assert.equal(again.state, first);
});

test('the same statement in another slot is still a change there', () => {
  const first = applyModelIntent(createIntentState(), { text: 'same belief', now: NOW }).state;
  const scoped = applyModelIntent(first, { text: 'same belief', now: NOW, projectId: PROJECT });
  assert.equal(scoped.changed, true);
  assert.equal(scoped.state.byProject[PROJECT].text, 'same belief');
});

test('a model with nothing to say leaves the statement standing', () => {
  const standing = applyModelIntent(createIntentState(), { text: 'a belief worth keeping', now: NOW, projectId: PROJECT }).state;
  for (const empty of ['', '   ', null, undefined, 42, {}, []]) {
    const result = applyModelIntent(standing, { text: empty, now: NOW + 5000, projectId: PROJECT });
    assert.equal(result.changed, false, `${JSON.stringify(empty)} must not clear the statement`);
    assert.equal(result.state.byProject[PROJECT].text, 'a belief worth keeping');
  }
});

test('a project with no statement of its own reads the global one', () => {
  const global = applyModelIntent(createIntentState(), { text: 'the machine-wide belief', now: NOW }).state;
  assert.equal(intentTextFor(global, PROJECT), 'the machine-wide belief');

  const scoped = applyModelIntent(global, { text: 'this project only', now: NOW, projectId: PROJECT }).state;
  assert.equal(intentTextFor(scoped, PROJECT), 'this project only');
  assert.equal(intentTextFor(scoped, OTHER_PROJECT), 'the machine-wide belief');
  assert.equal(intentTextFor(scoped, null), 'the machine-wide belief');
  assert.equal(intentTextFor(createIntentState(), PROJECT), '');
});

test('text is trimmed, capped, and strings only', () => {
  assert.equal(sanitizeIntentText('  padded  '), 'padded');
  assert.equal(sanitizeIntentText(12345), '');
  assert.equal(sanitizeIntentText({ text: 'nope' }), '');
  assert.equal(sanitizeIntentText(null), '');

  const long = 'x'.repeat(MAX_INTENT_CHARS + 120);
  assert.equal(sanitizeIntentText(long).length, MAX_INTENT_CHARS);
  assert.equal(applyModelIntent(createIntentState(), { text: long, now: NOW }).state.global.text.length, MAX_INTENT_CHARS);
});

test('a persisted per-project state revives with sanitized text and timestamps', () => {
  assert.deepEqual(reviveIntentState({
    global: { text: '  durable model statement  ', source: 'model', ts: NOW },
    byProject: { [PROJECT]: { text: 'this project only', source: 'model' } },
  }), {
    global: { text: 'durable model statement', source: 'model', ts: NOW },
    byProject: { [PROJECT]: { text: 'this project only', source: 'model', ts: 0 } },
  });
});

test('the legacy flat file revives as the global statement', () => {
  assert.deepEqual(reviveIntentState({
    text: '  durable model statement  ', source: 'model', ts: NOW,
  }), {
    global: { text: 'durable model statement', source: 'model', ts: NOW },
    byProject: {},
  });
});

test('a legacy locked intent revives without the lock and accepts a model proposal', () => {
  const revived = reviveIntentState({
    text: '  durable operator statement  ', source: 'operator', locked: true, ts: NOW,
  });
  assert.deepEqual(revived, {
    global: { text: 'durable operator statement', source: 'model', ts: NOW },
    byProject: {},
  });

  const proposed = applyModelIntent(revived, { text: 'new model belief', now: NOW + 1000 });
  assert.equal(proposed.changed, true);
  assert.deepEqual(proposed.state.global, {
    text: 'new model belief', source: 'model', ts: NOW + 1000,
  });
});

test('revival drops the slots that are invalid and keeps the ones that are not', () => {
  const invalidSlots = [
    { text: 'has no domain', source: 'system', ts: NOW },
    { text: 'bad timestamp', source: 'model', ts: Number.POSITIVE_INFINITY },
    { text: 'negative timestamp', source: 'model', ts: -1 },
    { text: '   ', source: 'model', ts: NOW },
    'a bare string',
    null,
  ];
  for (const raw of invalidSlots) {
    assert.deepEqual(reviveIntentState(raw), createIntentState());
    assert.deepEqual(reviveIntentState({ global: raw, byProject: { [PROJECT]: raw } }), createIntentState());
  }

  assert.deepEqual(reviveIntentState({
    global: { text: 'bad timestamp', source: 'model', ts: -1 },
    byProject: { [PROJECT]: { text: 'still good', source: 'model', ts: NOW } },
  }), {
    global: null,
    byProject: { [PROJECT]: { text: 'still good', source: 'model', ts: NOW } },
  });
});

test('revival never throws on junk persisted values', () => {
  for (const raw of [null, undefined, 42, true, [], ['text'], 'intent', { byProject: 7 }, { byProject: ['x'] }]) {
    assert.doesNotThrow(() => reviveIntentState(raw));
    assert.deepEqual(reviveIntentState(raw), createIntentState());
  }
});

test('a project id the config no longer knows is pruned, and an unsupplied list prunes nothing', () => {
  const stored = {
    global: { text: 'the global belief', source: 'model', ts: NOW },
    byProject: {
      [PROJECT]: { text: 'still configured', source: 'model', ts: NOW },
      [OTHER_PROJECT]: { text: 'deleted project', source: 'model', ts: NOW },
    },
  };

  assert.deepEqual(reviveIntentState(stored, { projectIds: [PROJECT] }), {
    global: { text: 'the global belief', source: 'model', ts: NOW },
    byProject: { [PROJECT]: { text: 'still configured', source: 'model', ts: NOW } },
  });

  const kept = reviveIntentState(stored);
  assert.deepEqual(Object.keys(kept.byProject).sort(), [PROJECT, OTHER_PROJECT].sort());
  assert.equal(pruneIntentProjects(kept, null), kept, 'no list is no pruning, not an empty list');
  assert.deepEqual(pruneIntentProjects(kept, []).byProject, {});
  assert.deepEqual(pruneIntentProjects(kept, [PROJECT, OTHER_PROJECT]), kept);
});

test('a global statement survives a prune that empties every project slot', () => {
  const state = applyModelIntent(
    applyModelIntent(createIntentState(), { text: 'the global belief', now: NOW }).state,
    { text: 'a deleted project', now: NOW, projectId: OTHER_PROJECT },
  ).state;
  const pruned = pruneIntentProjects(state, [PROJECT]);
  assert.deepEqual(pruned.global, { text: 'the global belief', source: 'model', ts: NOW });
  assert.equal(isEmptyIntent(pruned), false);
});

test('the payload is a copy carrying exactly the wire fields', () => {
  const state = applyModelIntent(
    applyModelIntent(createIntentState(), { text: 'on the wire', now: NOW }).state,
    { text: 'and this project', now: NOW, projectId: PROJECT },
  ).state;
  const payload = intentPayload(state);
  assert.deepEqual(payload, {
    global: { text: 'on the wire', source: 'model', ts: NOW },
    byProject: { [PROJECT]: { text: 'and this project', source: 'model', ts: NOW } },
  });

  payload.global.text = 'mutated';
  payload.byProject[PROJECT].text = 'mutated';
  delete payload.byProject[OTHER_PROJECT];
  assert.equal(state.global.text, 'on the wire');
  assert.equal(state.byProject[PROJECT].text, 'and this project');

  assert.deepEqual(intentPayload(null), { global: null, byProject: {} });
  assert.deepEqual(createIntentSlot(), { text: '', source: null, ts: 0 });
});
