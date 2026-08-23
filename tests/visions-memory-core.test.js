'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  basenameOfUri,
  createBoundedKeySet,
  dismissFeedbackInput,
  dispatchMemoryInputs,
  servedFindingOf,
  fixFeedbackInput,
  intentMemoryInput,
  latestIntentHeads,
  projectTagFor,
  readDismissParams,
  sanitizeOneLine,
  servedFeedbackInput,
  servedKey,
} = require('../server/core/visions-memory-core');

const SCOPE = [
  { id: 'p1', path: 'c:/repos/glissa' },
  { id: 'p2', path: 'c:/repos/other' },
];

test('the project tag is the folded repo path, never the Glissa project id', () => {
  assert.equal(projectTagFor('p2', SCOPE), 'c:/repos/other');
  assert.equal(projectTagFor('unknown', SCOPE), null);
  assert.equal(projectTagFor(null, SCOPE), null);
  assert.equal(projectTagFor('p1', null), null);
});

test('a basename survives percent encoding, a fragment and both slash kinds', () => {
  assert.equal(basenameOfUri('file:///c:/repos/glissa/docs/plan%20one.md'), 'plan one.md');
  assert.equal(basenameOfUri('file:///c:/repos/glissa/notes.md#heading'), 'notes.md');
  assert.equal(basenameOfUri('c:\\repos\\glissa\\notes.md'), 'notes.md');
  assert.equal(basenameOfUri(''), 'document');
});

test('a one-line sanitize folds newlines and control characters into single spaces', () => {
  const raw = `first${String.fromCharCode(10)}second${String.fromCharCode(9)}third${String.fromCharCode(0)}`;
  assert.equal(sanitizeOneLine(raw, 100), 'first second third');
  assert.equal(sanitizeOneLine('x'.repeat(20), 5), 'xxxxx');
});

test('an intent record is a model-stamped semantic claim carrying its supersession', () => {
  const input = intentMemoryInput({ text: ' shipping M13 ', project: 'c:/repos/glissa', supersedes: 'm-abc' });
  assert.deepEqual(input, {
    kind: 'intent',
    layer: 'semantic',
    project: 'c:/repos/glissa',
    source: { kind: 'model', vendor: 'glissa', sessionId: null },
    text: 'shipping M13',
    supersedes: 'm-abc',
  });
  assert.equal(intentMemoryInput({ text: '   ' }), null);
});

test('a global-slot intent proposal carries no project tag', () => {
  assert.equal(intentMemoryInput({ text: 'anything' }).project, null);
});

test('the intent head per slot is the newest record for that slot', () => {
  const heads = latestIntentHeads([
    { kind: 'intent', project: null, id: 'g1', ts: 10 },
    { kind: 'intent', project: null, id: 'g2', ts: 20 },
    { kind: 'intent', project: 'c:/repos/glissa', id: 'p1', ts: 30 },
    { kind: 'knowledge', project: null, id: 'k1', ts: 99 },
  ]);
  assert.equal(heads.get(''), 'g2');
  assert.equal(heads.get('c:/repos/glissa'), 'p1');
  assert.equal(heads.has('k1'), false);
});

test('dispatch comments and the tier 4 hand become episodic model knowledge', () => {
  const inputs = dispatchMemoryInputs({
    uri: 'file:///c:/repos/glissa/docs/notes.md',
    project: 'c:/repos/glissa',
    comments: [{ line: 12, message: 'one suggestion' }, { line: 0, message: 'bad line' }, { line: 3, message: '  ' }],
    hand: 'the structure drifts',
  });
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], {
    kind: 'knowledge',
    layer: 'episodic',
    project: 'c:/repos/glissa',
    source: { kind: 'model', vendor: 'glissa', sessionId: null },
    text: 'notes.md:12: one suggestion',
    supersedes: null,
  });
  assert.equal(inputs[1].text, 'notes.md: the structure drifts');
});

test('a dispatch with nothing to say writes nothing', () => {
  assert.deepEqual(dispatchMemoryInputs({ uri: 'file:///x/y.md', comments: [], hand: null }), []);
});

test('an applied fix is action-ranked feedback naming the rule and its 1-based line', () => {
  const fix = { code: 'repeated-word', range: { start: { line: 4, character: 2 } } };
  const input = fixFeedbackInput({ uri: 'file:///c:/repos/glissa/a.md', project: 'c:/repos/glissa', fix });
  assert.equal(input.kind, 'feedback');
  assert.equal(input.layer, 'episodic');
  assert.deepEqual(input.source, { kind: 'action', vendor: 'glissa', sessionId: null });
  assert.equal(input.text, 'applied repeated-word at a.md:5');
  assert.equal(fixFeedbackInput({ uri: 'file:///a.md', fix: {} }), null);
});

test('a served finding id is the rule plus its position, and its key spans uri and version', () => {
  const fix = { code: 'heading-skip', range: { start: { line: 6, character: 0 } } };
  assert.deepEqual(servedFindingOf(fix), { id: 'heading-skip@7:0', line: 7 });
  assert.equal(servedKey({ uri: 'file:///a.md', version: 3, id: 'x' }), 'file:///a.md|3|x');
  assert.equal(servedKey({ uri: 'file:///a.md', version: null, id: 'x' }), 'file:///a.md|none|x');
  assert.notEqual(
    servedKey({ uri: 'file:///a.md', version: 3, id: 'x' }),
    servedKey({ uri: 'file:///a.md', version: 4, id: 'x' })
  );
});

test('a served record is action-ranked and names where the finding sat', () => {
  const input = servedFeedbackInput({
    uri: 'file:///c:/repos/glissa/a.md', project: 'c:/repos/glissa', id: 'heading-skip@7:0', line: 7,
  });
  assert.equal(input.text, 'served heading-skip@7:0 at a.md:7');
  assert.deepEqual(input.source, { kind: 'action', vendor: 'glissa', sessionId: null });
  assert.equal(servedFeedbackInput({ uri: 'file:///a.md', id: '  ' }), null);
});

test('a dismissal is action-ranked and carries only the finding id', () => {
  const input = dismissFeedbackInput({ uri: 'file:///c:/repos/glissa/a.md', project: null, id: 'heading-skip@7:0' });
  assert.equal(input.text, 'dismissed heading-skip@7:0 at a.md');
  assert.equal(input.project, null);
  assert.deepEqual(input.source, { kind: 'action', vendor: 'glissa', sessionId: null });
});

test('a dismissal payload is read from either uri spelling and refused when unusable', () => {
  assert.deepEqual(readDismissParams({ uri: 'file:///a.md', id: 'x' }), { uri: 'file:///a.md', id: 'x' });
  assert.deepEqual(
    readDismissParams({ textDocument: { uri: 'file:///a.md' }, id: 'x' }),
    { uri: 'file:///a.md', id: 'x' }
  );
  for (const bad of [null, 'string', [], {}, { uri: 'file:///a.md' }, { id: 'x' }, { uri: 'file:///a.md', id: 42 }]) {
    assert.equal(readDismissParams(bad), null);
  }
});

test('a dismissal payload can claim no rank of its own', () => {
  const read = readDismissParams({ uri: 'file:///a.md', id: 'x', source: { kind: 'operator' }, locked: true });
  assert.deepEqual(read, { uri: 'file:///a.md', id: 'x' });
  const input = dismissFeedbackInput({ uri: read.uri, id: read.id });
  assert.equal(input.source.kind, 'action');
  assert.equal(input.locked, undefined);
});

test('the served key set dedupes and evicts oldest first', () => {
  const keys = createBoundedKeySet(2);
  assert.equal(keys.add('a'), true);
  assert.equal(keys.add('a'), false);
  keys.add('b');
  keys.add('c');
  assert.equal(keys.size, 2);
  assert.equal(keys.has('a'), false);
  assert.equal(keys.has('c'), true);
});
