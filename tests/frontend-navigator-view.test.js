'use strict';

// The Navigator tab's pure half: which sections exist, in what order, and what the counts read as.

const test = require('node:test');
const assert = require('node:assert/strict');

// navigator-view-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/navigator-view-core.mjs');

function finding(line, character, code, message) {
  return {
    range: { start: { line, character }, end: { line, character: character + 1 } },
    severity: 2,
    source: 'glissa-navigator',
    code,
    message,
  };
}

test('a file uri renders as its decoded basename and keeps the raw uri reachable', async () => {
  const { basenameOfUri } = await importCore();
  assert.equal(basenameOfUri('file:///tmp/plan-navigator.md'), 'plan-navigator.md');
  assert.equal(basenameOfUri('file:///c%3A/Users/johnw/My%20Docs/notes.md'), 'notes.md');
  assert.equal(basenameOfUri('untitled:Untitled-1'), 'untitled:Untitled-1');
  assert.equal(basenameOfUri(''), '');
});

test('a percent escape that does not decode falls back to the raw tail rather than throwing', async () => {
  const { basenameOfUri } = await importCore();
  assert.equal(basenameOfUri('file:///tmp/100%.md'), '100%.md');
});

test('line labels are one-based, because that is what the editor shows', async () => {
  const { findingLineLabel } = await importCore();
  assert.equal(findingLineLabel(finding(0, 0, 'repeated-word', 'x')), 'L1');
  assert.equal(findingLineLabel(finding(11, 3, 'repeated-word', 'x')), 'L12');
  assert.equal(findingLineLabel({}), 'L?');
});

test('the count reads as a sentence, singular included', async () => {
  const { findingCountText } = await importCore();
  assert.equal(findingCountText(0), '0 findings');
  assert.equal(findingCountText(1), '1 finding');
  assert.equal(findingCountText(4), '4 findings');
});

test('a per-uri push replaces that document and leaves the others alone', async () => {
  const { applyFindingsMessage } = await importCore();
  const first = applyFindingsMessage(new Map(), {
    type: 'navigator-findings', uri: 'file:///a.md', diagnostics: [finding(0, 0, 'repeated-word', 'a')],
  });
  const second = applyFindingsMessage(first, {
    type: 'navigator-findings', uri: 'file:///b.md', diagnostics: [finding(1, 0, 'heading-skip', 'b')],
  });

  assert.deepEqual([...second.keys()], ['file:///a.md', 'file:///b.md']);
  assert.equal(first.size, 1, 'the previous map is never mutated');
});

test('an empty push clears that uri instead of leaving an empty section', async () => {
  const { applyFindingsMessage } = await importCore();
  const withFinding = applyFindingsMessage(new Map(), {
    uri: 'file:///a.md', diagnostics: [finding(0, 0, 'repeated-word', 'a')],
  });
  const cleared = applyFindingsMessage(withFinding, { uri: 'file:///a.md', diagnostics: [] });
  assert.equal(cleared.size, 0);
});

test('a message with no uri changes nothing', async () => {
  const { applyFindingsMessage } = await importCore();
  const start = applyFindingsMessage(new Map(), { uri: 'file:///a.md', diagnostics: [finding(0, 0, 'x', 'a')] });
  assert.deepEqual([...applyFindingsMessage(start, { diagnostics: [] }).keys()], ['file:///a.md']);
});

test('the connect-time snapshot REPLACES the map, so a document closed during the gap disappears', async () => {
  const { applyFindingsSnapshot } = await importCore();
  const repaired = applyFindingsSnapshot({
    type: 'navigator-snapshot',
    documents: [
      { uri: 'file:///b.md', diagnostics: [finding(0, 0, 'repeated-word', 'b')] },
      { uri: 'file:///empty.md', diagnostics: [] },
    ],
  });
  assert.deepEqual([...repaired.keys()], ['file:///b.md'], 'an empty document earns no section');
  assert.equal(applyFindingsSnapshot({}).size, 0, 'a malformed frame empties rather than throws');
});

test('sections sort by file name, findings sort by position', async () => {
  const { findingSections } = await importCore();
  const map = new Map([
    ['file:///deep/zebra.md', [finding(0, 0, 'repeated-word', 'z')]],
    ['file:///apple.md', [
      finding(9, 4, 'repeated-word', 'later on the same line'),
      finding(2, 0, 'heading-skip', 'earlier line'),
      finding(9, 1, 'repeated-word', 'earlier on the same line'),
    ]],
  ]);

  const sections = findingSections(map);
  assert.deepEqual(sections.map((section) => section.name), ['apple.md', 'zebra.md']);
  assert.equal(sections[0].uri, 'file:///apple.md', 'the full uri stays with the section for the title');
  assert.deepEqual(sections[0].findings.map((f) => f.message), [
    'earlier line', 'earlier on the same line', 'later on the same line',
  ]);
});

test('two files of the same name are ordered by their full uri, not left to insertion order', async () => {
  const { findingSections } = await importCore();
  const map = new Map([
    ['file:///z/notes.md', [finding(0, 0, 'repeated-word', 'z')]],
    ['file:///a/notes.md', [finding(0, 0, 'repeated-word', 'a')]],
  ]);
  assert.deepEqual(findingSections(map).map((section) => section.uri), ['file:///a/notes.md', 'file:///z/notes.md']);
});

test('the totals and the arrival test read the same feed', async () => {
  const { totalFindingCount, hasFindings, NAVIGATOR_EMPTY_TEXT } = await importCore();
  const map = new Map([
    ['file:///a.md', [finding(0, 0, 'x', 'a'), finding(1, 0, 'x', 'b')]],
    ['file:///b.md', [finding(0, 0, 'x', 'c')]],
  ]);
  assert.equal(totalFindingCount(map), 3);
  assert.equal(totalFindingCount(new Map()), 0);
  assert.equal(hasFindings({ diagnostics: [finding(0, 0, 'x', 'a')] }), true);
  assert.equal(hasFindings({ diagnostics: [] }), false);
  assert.equal(hasFindings({}), false);
  assert.equal(NAVIGATOR_EMPTY_TEXT, 'No findings. Open a markdown file in a connected editor.');
});
