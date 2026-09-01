'use strict';

// The Visions tab's pure half: which sections exist, in what order, and what the counts read as.

const test = require('node:test');
const assert = require('node:assert/strict');

// visions-view-core is ESM; dynamic-import it from this CJS test file.
const importCore = () => import('../public/visions-view-core.mjs');

function finding(line, character, code, message) {
  return {
    range: { start: { line, character }, end: { line, character: character + 1 } },
    severity: 2,
    source: 'glissa-visions',
    code,
    message,
  };
}

test('a file uri renders as its decoded basename and keeps the raw uri reachable', async () => {
  const { basenameOfUri } = await importCore();
  assert.equal(basenameOfUri('file:///tmp/plan-visions.md'), 'plan-visions.md');
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
    type: 'visions-findings', uri: 'file:///a.md', diagnostics: [finding(0, 0, 'repeated-word', 'a')],
  });
  const second = applyFindingsMessage(first, {
    type: 'visions-findings', uri: 'file:///b.md', diagnostics: [finding(1, 0, 'heading-skip', 'b')],
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
    type: 'visions-snapshot',
    documents: [
      { uri: 'file:///b.md', diagnostics: [finding(0, 0, 'repeated-word', 'b')] },
      { uri: 'file:///empty.md', diagnostics: [] },
    ],
  });
  assert.deepEqual([...repaired.keys()], ['file:///b.md'], 'an empty document earns no section');
  assert.equal(applyFindingsSnapshot({}).size, 0, 'a malformed frame empties rather than throws');
});

test('sections sort by file name, findings sort by position', async () => {
  const { visionsSections } = await importCore();
  const map = new Map([
    ['file:///deep/zebra.md', [finding(0, 0, 'repeated-word', 'z')]],
    ['file:///apple.md', [
      finding(9, 4, 'repeated-word', 'later on the same line'),
      finding(2, 0, 'heading-skip', 'earlier line'),
      finding(9, 1, 'repeated-word', 'earlier on the same line'),
    ]],
  ]);

  const sections = visionsSections(map);
  assert.deepEqual(sections.map((section) => section.name), ['apple.md', 'zebra.md']);
  assert.equal(sections[0].uri, 'file:///apple.md', 'the full uri stays with the section for the title');
  assert.deepEqual(sections[0].findings.map((f) => f.message), [
    'earlier line', 'earlier on the same line', 'later on the same line',
  ]);
});

test('two files of the same name are ordered by their full uri, not left to insertion order', async () => {
  const { visionsSections } = await importCore();
  const map = new Map([
    ['file:///z/notes.md', [finding(0, 0, 'repeated-word', 'z')]],
    ['file:///a/notes.md', [finding(0, 0, 'repeated-word', 'a')]],
  ]);
  assert.deepEqual(visionsSections(map).map((section) => section.uri), ['file:///a/notes.md', 'file:///z/notes.md']);
});

test('the totals and the arrival test read the same feed', async () => {
  const { totalFindingCount, hasFindings, VISIONS_EMPTY_TEXT } = await importCore();
  const map = new Map([
    ['file:///a.md', [finding(0, 0, 'x', 'a'), finding(1, 0, 'x', 'b')]],
    ['file:///b.md', [finding(0, 0, 'x', 'c')]],
  ]);
  assert.equal(totalFindingCount(map), 3);
  assert.equal(totalFindingCount(new Map()), 0);
  assert.equal(hasFindings({ diagnostics: [finding(0, 0, 'x', 'a')] }), true);
  assert.equal(hasFindings({ diagnostics: [] }), false);
  assert.equal(hasFindings({}), false);
  assert.equal(VISIONS_EMPTY_TEXT, 'No findings. Open a markdown file in a connected editor.');
});

// --- Tier 3 model comments (docs/archive/plan-navigator.md, M4) ---

function comment(line, message) {
  return { line, message };
}

test('a comments push replaces that document, and an empty one clears it', async () => {
  const { applyCommentsMessage } = await importCore();
  const first = applyCommentsMessage(new Map(), {
    type: 'visions-comments', uri: 'file:///a.md', comments: [comment(3, 'name the audience')],
  });
  assert.deepEqual([...first.keys()], ['file:///a.md']);

  const replaced = applyCommentsMessage(first, { uri: 'file:///a.md', comments: [comment(9, 'a different thought')] });
  assert.deepEqual(replaced.get('file:///a.md'), [comment(9, 'a different thought')]);
  assert.equal(first.get('file:///a.md').length, 1, 'the previous map is never mutated');

  assert.equal(applyCommentsMessage(replaced, { uri: 'file:///a.md', comments: [] }).size, 0);
  assert.deepEqual([...applyCommentsMessage(replaced, { comments: [] }).keys()], ['file:///a.md'], 'no uri changes nothing');
});

test('the snapshot carries both halves, and each half reads only its own field', async () => {
  const { applyCommentsSnapshot, applyFindingsSnapshot, applyHandSnapshot } = await importCore();
  const msg = {
    type: 'visions-snapshot',
    documents: [
      {
        uri: 'file:///both.md',
        diagnostics: [finding(0, 0, 'repeated-word', 'b')],
        comments: [comment(1, 'a thought')],
        hand: 'the structure shifts halfway through',
      },
      { uri: 'file:///findings-only.md', diagnostics: [finding(1, 0, 'heading-skip', 'h')], comments: [] },
      { uri: 'file:///comments-only.md', diagnostics: [], comments: [comment(2, 'another thought')] },
      { uri: 'file:///hand-only.md', diagnostics: [], comments: [], hand: 'the premise and outline disagree' },
    ],
  };
  assert.deepEqual([...applyFindingsSnapshot(msg).keys()], ['file:///both.md', 'file:///findings-only.md']);
  assert.deepEqual([...applyCommentsSnapshot(msg).keys()], ['file:///both.md', 'file:///comments-only.md']);
  assert.deepEqual([...applyHandSnapshot(msg).keys()], ['file:///both.md', 'file:///hand-only.md']);
  assert.equal(applyCommentsSnapshot({}).size, 0, 'a malformed frame empties rather than throws');
});

test('a hand push replaces that document, and a null one clears it', async () => {
  const { applyHandMessage, hasHand, visionsHandText } = await importCore();
  const first = applyHandMessage(new Map(), {
    type: 'visions-hand', uri: 'file:///a.md', hand: '  the outline and conclusion argue different plans  ',
  });
  assert.equal(first.get('file:///a.md'), 'the outline and conclusion argue different plans');
  assert.equal(visionsHandText(first.get('file:///a.md')), 'Raised hand: the outline and conclusion argue different plans');
  assert.equal(hasHand({ uri: 'file:///a.md', hand: 'a structural issue' }), true);
  assert.equal(hasHand({ uri: 'file:///a.md', hand: null }), false);

  const replaced = applyHandMessage(first, { uri: 'file:///a.md', hand: 'the document has two audiences' });
  assert.equal(replaced.get('file:///a.md'), 'the document has two audiences');
  assert.equal(first.get('file:///a.md'), 'the outline and conclusion argue different plans');

  assert.equal(applyHandMessage(replaced, { uri: 'file:///a.md', hand: null }).size, 0);
  assert.deepEqual([...applyHandMessage(replaced, { hand: null }).keys()], ['file:///a.md'], 'no uri changes nothing');
  assert.equal(visionsHandText(null), '');
});

test('a document earns a section from any visions surface, and hand renders first', async () => {
  const { visionsSections } = await importCore();
  const findings = new Map([['file:///apple.md', [finding(4, 0, 'repeated-word', 'a')]]]);
  const comments = new Map([
    ['file:///apple.md', [comment(9, 'later'), comment(2, 'earlier')]],
    ['file:///zebra.md', [comment(1, 'comments only, no findings at all')]],
  ]);
  const hands = new Map([
    ['file:///apple.md', 'the document has two centers'],
    ['file:///middle.md', 'the section order hides the decision'],
  ]);

  const sections = visionsSections(findings, comments, hands);
  assert.deepEqual(sections.map((section) => section.name), ['apple.md', 'middle.md', 'zebra.md']);
  assert.equal(sections[0].hand, 'the document has two centers');
  assert.deepEqual(sections[0].comments.map((entry) => entry.message), ['earlier', 'later']);
  assert.equal(sections[1].hand, 'the section order hides the decision');
  assert.deepEqual(sections[2].findings, [], 'a comments-only document still gets its section');
  assert.deepEqual(visionsSections(new Map(), new Map(), new Map()), []);
});

test('the section head names what it actually has, and never pads with a zero', async () => {
  const { commentCountText, sectionCountText } = await importCore();
  assert.equal(commentCountText(1), '1 comment');
  assert.equal(commentCountText(3), '3 comments');
  assert.equal(sectionCountText({ hand: 'whole doc issue', findings: [1, 2], comments: [1] }), 'raised hand, 2 findings, 1 comment');
  assert.equal(sectionCountText({ findings: [], comments: [1, 2] }), '2 comments');
  assert.equal(sectionCountText({ findings: [1], comments: [] }), '1 finding');
  assert.equal(sectionCountText({ hand: 'whole doc issue', findings: [], comments: [] }), 'raised hand');
  assert.equal(sectionCountText({}), '0 findings');
});

test('comment lines are already 1-based, unlike the LSP ranges beside them', async () => {
  const { commentLineLabel, totalCommentCount, hasComments } = await importCore();
  assert.equal(commentLineLabel(comment(1, 'x')), 'L1');
  assert.equal(commentLineLabel(comment(12, 'x')), 'L12');
  assert.equal(commentLineLabel({}), 'L?');
  assert.equal(commentLineLabel(comment(0, 'x')), 'L?');

  assert.equal(totalCommentCount(new Map([['a', [comment(1, 'x'), comment(2, 'y')]], ['b', [comment(1, 'z')]]])), 3);
  assert.equal(hasComments({ comments: [comment(1, 'x')] }), true);
  assert.equal(hasComments({}), false);
});

// --- The intent block as threads (docs/plan-visions-4-focus.md, M20) ---

const NOW = 1700000000000;
const PROJECT = 'e1f4c0de-0000-4000-8000-000000000001';
const OTHER_PROJECT = 'e1f4c0de-0000-4000-8000-000000000002';

function thread(id, text, ts = NOW, extra = {}) {
  return {
    id, text, uris: [], ts, hits: 1, ...extra,
  };
}

test('a thread is normalized, and anything malformed reads as no thread', async () => {
  const { normalizeIntentThread } = await importCore();
  assert.deepEqual(normalizeIntentThread({
    id: 't-716d49b4', text: 'refactor of the spawn path', uris: ['file:///a.md', 7], ts: NOW, hits: 3,
  }), {
    id: 't-716d49b4', text: 'refactor of the spawn path', uris: ['file:///a.md'], ts: NOW, hits: 3,
  });
  assert.deepEqual(normalizeIntentThread({ text: 'a lifted slot', source: 'model', ts: 'soon' }), {
    id: null, text: 'a lifted slot', uris: [], ts: 0, hits: 1,
  });
  for (const raw of [undefined, null, 'a bare string', { text: '' }, { id: 't-716d49b4' }]) {
    assert.equal(normalizeIntentThread(raw), null);
  }
});

test('the source line credits the visions when a statement exists', async () => {
  const { intentSourceText } = await importCore();
  assert.equal(intentSourceText({ text: 'x' }), 'proposed by visions');
  assert.equal(intentSourceText({ text: '' }), '', 'no statement, nobody to credit');
});

test('the age reads coarsely, because the question is minutes or days and never seconds', async () => {
  const { intentAgeText } = await importCore();
  assert.equal(intentAgeText(NOW, NOW + 20000), 'just now');
  assert.equal(intentAgeText(NOW, NOW + 60000), '1 minute ago');
  assert.equal(intentAgeText(NOW, NOW + 45 * 60000), '45 minutes ago');
  assert.equal(intentAgeText(NOW, NOW + 3600000), '1 hour ago');
  assert.equal(intentAgeText(NOW, NOW + 5 * 3600000), '5 hours ago');
  assert.equal(intentAgeText(NOW, NOW + 26 * 3600000), '1 day ago');
  assert.equal(intentAgeText(NOW, NOW + 3 * 24 * 3600000), '3 days ago');
  assert.equal(intentAgeText(NOW, NOW - 5000), 'just now', 'a clock that went backwards is not a future statement');
  assert.equal(intentAgeText(0, NOW), '');
});

test('the meta line names the thread, the source and the age, and says nothing with no statement', async () => {
  const { intentMetaText } = await importCore();
  assert.equal(intentMetaText(thread('t-716d49b4', 'x'), NOW + 120000), 'thread t-716d49b4, proposed by visions, 2 minutes ago');
  assert.equal(intentMetaText(thread('t-716d49b4', 'x', 0), NOW), 'thread t-716d49b4, proposed by visions');
  assert.equal(intentMetaText(thread(null, 'x'), NOW + 120000), 'proposed by visions, 2 minutes ago');
  assert.equal(intentMetaText({ text: '' }, NOW), '');
});

test('a snapshot carries every thread per project, and both legacy slot shapes lift into one thread each', async () => {
  const { emptyIntentState, intentStateOfMessage } = await importCore();
  const a = thread('t-11111111', 'story A');
  const b = thread('t-22222222', 'story B');
  assert.deepEqual(intentStateOfMessage({
    intent: { byProject: { [PROJECT]: [a, b], [OTHER_PROJECT]: [] }, unowned: [thread('t-33333333', 'unowned')] },
  }), { byProject: { [PROJECT]: [a, b] }, unowned: [thread('t-33333333', 'unowned')] });

  assert.deepEqual(intentStateOfMessage({
    intent: {
      global: { text: 'the machine-wide belief', source: 'model', ts: NOW },
      byProject: { [PROJECT]: { text: 'this project only', source: 'model', ts: NOW } },
    },
  }), { byProject: { [PROJECT]: [thread(null, 'this project only')] }, unowned: [thread(null, 'the machine-wide belief')] });

  assert.deepEqual(intentStateOfMessage({ intent: { text: 'an older server', source: 'model', ts: NOW } }), {
    byProject: {}, unowned: [thread(null, 'an older server')],
  });
  for (const msg of [{}, { intent: null }, { intent: 'a bare string' }, { intent: { byProject: 7 } }]) {
    assert.deepEqual(intentStateOfMessage(msg), emptyIntentState());
  }
});

test('an intent delta replaces the list of the project it names and leaves the rest alone', async () => {
  const { applyIntentMessage, emptyIntentState } = await importCore();
  const unownedThread = thread('t-33333333', 'the unowned belief');
  const withUnowned = applyIntentMessage(emptyIntentState(), {
    intent: { active: unownedThread, threads: [unownedThread] },
  });
  assert.deepEqual(withUnowned, { byProject: {}, unowned: [unownedThread] });

  const a = thread('t-11111111', 'story A');
  const b = thread('t-22222222', 'story B');
  const withProject = applyIntentMessage(withUnowned, { projectId: PROJECT, intent: { active: b, threads: [b, a] } });
  assert.deepEqual(withProject, { byProject: { [PROJECT]: [b, a] }, unowned: [unownedThread] });

  const emptied = applyIntentMessage(withProject, { projectId: PROJECT, intent: { active: null, threads: [] } });
  assert.deepEqual(emptied, { byProject: {}, unowned: [unownedThread] }, 'an empty list is a project with nothing left');
  assert.equal(applyIntentMessage(withProject, { projectId: PROJECT, intent: null }), withProject);
});

test('the active thread on the wire leads the list, and a payload naming none leaves the first one active', async () => {
  const { applyIntentMessage, emptyIntentState, intentRows } = await importCore();
  const a = thread('t-11111111', 'story A');
  const b = thread('t-22222222', 'story B');
  const named = applyIntentMessage(emptyIntentState(), { projectId: PROJECT, intent: { active: b, threads: [a, b] } });
  assert.deepEqual(named.byProject[PROJECT], [b, a]);
  assert.deepEqual(intentRows(named, null, NOW).map((row) => [row.text, row.active]), [['story B', true], ['story A', false]]);

  const unnamed = applyIntentMessage(emptyIntentState(), { projectId: PROJECT, intent: { threads: [a, b] } });
  assert.deepEqual(unnamed.byProject[PROJECT], [a, b], 'no active on the wire keeps the order it arrived in');
  assert.deepEqual(intentRows(unnamed, null, NOW).map((row) => row.active), [true, false]);

  const unknown = applyIntentMessage(emptyIntentState(), {
    projectId: PROJECT, intent: { active: thread('t-99999999', 'gone'), threads: [a, b] },
  });
  assert.deepEqual(unknown.byProject[PROJECT], [a, b], 'an active the list does not carry moves nothing');
});

test('intent rows list the unowned threads first, then each project by name with its active thread first', async () => {
  const { intentRows, VISIONS_INTENT_UNOWNED_LABEL } = await importCore();
  const state = {
    byProject: {
      [OTHER_PROJECT]: [thread('t-44444444', 'the other one')],
      [PROJECT]: [thread('t-11111111', 'this project, active'), thread('t-22222222', 'this project, also')],
    },
    unowned: [thread('t-33333333', 'the unowned belief')],
  };
  const names = new Map([[PROJECT, 'Alpha']]);
  const rows = intentRows(state, names, NOW + 120000);
  assert.deepEqual(rows.map((row) => row.label), [VISIONS_INTENT_UNOWNED_LABEL, 'Alpha', 'Alpha', OTHER_PROJECT]);
  assert.deepEqual(rows.map((row) => row.text), ['the unowned belief', 'this project, active', 'this project, also', 'the other one']);
  assert.deepEqual(rows.map((row) => row.active), [true, true, false, true]);
  assert.equal(rows[1].meta, 'thread t-11111111, proposed by visions, 2 minutes ago');
  assert.equal(rows.every((row) => row.hasText), true);
});

test('the unowned row is the empty state, and steps aside once anything speaks', async () => {
  const { emptyIntentState, intentRows, VISIONS_INTENT_EMPTY_TEXT } = await importCore();
  const empty = intentRows(emptyIntentState(), null, NOW);
  assert.equal(empty.length, 1);
  assert.equal(empty[0].text, VISIONS_INTENT_EMPTY_TEXT);
  assert.equal(empty[0].hasText, false);
  assert.equal(empty[0].active, false);
  assert.equal(empty[0].meta, '');

  const scopedOnly = intentRows({ byProject: { [PROJECT]: [thread('t-11111111', 'this project only')] }, unowned: [] }, null, NOW);
  assert.deepEqual(scopedOnly.map((row) => row.key), [`${PROJECT}:t-11111111`]);
});

test('a repaint fires when a thread moves or the active one changes, and never on age alone', async () => {
  const { emptyIntentState, hasIntentStateChanged } = await importCore();
  const a = thread('t-11111111', 'story A');
  const b = thread('t-22222222', 'story B');
  const state = { byProject: { [PROJECT]: [a, b] }, unowned: [thread('t-33333333', 'unowned')] };
  assert.equal(hasIntentStateChanged(state, {
    byProject: { [PROJECT]: [{ ...a, ts: NOW + 90000 }, b] }, unowned: [{ ...state.unowned[0], ts: NOW + 90000 }],
  }), false);
  assert.equal(hasIntentStateChanged(state, { ...state, byProject: { [PROJECT]: [{ ...a, text: 'moved' }, b] } }), true);
  assert.equal(hasIntentStateChanged(state, { ...state, byProject: { [PROJECT]: [b, a] } }), true, 'the active thread changed');
  assert.equal(hasIntentStateChanged(state, { byProject: {}, unowned: state.unowned }), true);
  assert.equal(hasIntentStateChanged(emptyIntentState(), state), true);
  assert.equal(hasIntentStateChanged(null, emptyIntentState()), false);
});

// --- Tier 1 fix changelog (docs/archive/plan-navigator-2.md, M6) ---

const APPLIED_FIX = {
  type: 'visions-fix',
  uri: 'file:///tmp/plan.md',
  fix: {
    code: 'repeated-word', line: 4, message: 'Repeated word "the"', applied: true,
  },
  ts: NOW,
};

test('a fix row reads as a one-based line and says plainly whether it landed', async () => {
  const { fixLineLabel, fixOutcomeText, fixCountText } = await importCore();
  assert.equal(fixLineLabel({ line: 4 }), 'L5');
  assert.equal(fixLineLabel({ line: 0 }), 'L1');
  assert.equal(fixLineLabel({}), 'L?');
  assert.equal(fixOutcomeText({ applied: true }), 'applied');
  assert.equal(fixOutcomeText({ applied: false }), 'refused');
  assert.equal(fixOutcomeText(null), 'refused', 'anything short of a real success reads as refused');
  assert.equal(fixCountText(0), '0 fixes');
  assert.equal(fixCountText(1), '1 fix');
  assert.equal(fixCountText(7), '7 fixes');
});

test('one broadcast becomes one row, taking the uri and the stamp off the frame around it', async () => {
  const { applyFixMessage, fixEntryOfMessage, hasFix } = await importCore();
  assert.equal(hasFix(APPLIED_FIX), true);
  assert.deepEqual(fixEntryOfMessage(APPLIED_FIX), {
    uri: 'file:///tmp/plan.md',
    code: 'repeated-word',
    line: 4,
    message: 'Repeated word "the"',
    applied: true,
    ts: NOW,
  });

  const rows = applyFixMessage([], APPLIED_FIX);
  assert.equal(rows.length, 1);
  assert.equal(applyFixMessage(rows, { ...APPLIED_FIX, ts: NOW + 1 })[0].ts, NOW + 1, 'newest first');
});

test('a frame with nothing to say leaves the list exactly as it was', async () => {
  const { applyFixMessage, hasFix } = await importCore();
  const rows = applyFixMessage([], APPLIED_FIX);
  assert.equal(hasFix({ type: 'visions-fix', uri: 'file:///tmp/plan.md' }), false);
  assert.deepEqual(applyFixMessage(rows, { type: 'visions-fix', fix: { message: '   ' } }), rows);
});

test('the snapshot ring replaces the tab list rather than merging into it', async () => {
  const { applyFixSnapshot } = await importCore();
  const rows = applyFixSnapshot({
    type: 'visions-snapshot',
    fixes: [
      {
        uri: 'file:///tmp/plan.md', code: 'repeated-word', line: 4, message: 'Repeated word "the"', applied: true, ts: NOW,
      },
      { uri: 'file:///tmp/plan.md', code: '', line: -3, message: 'refused one', applied: false },
      { uri: 'file:///tmp/plan.md', message: '' },
    ],
  });
  assert.equal(rows.length, 2, 'a record with no message is not a row this list can show');
  assert.equal(rows[1].line, 0, 'a line off the bottom of the buffer reads as the first one');
  assert.equal(rows[1].applied, false);
  assert.deepEqual(applyFixSnapshot({ type: 'visions-snapshot' }), []);
});

test('the rendered changelog is capped, however long the tab is left open', async () => {
  const { MAX_RENDERED_FIXES, applyFixMessage } = await importCore();
  let rows = [];
  for (let index = 0; index < MAX_RENDERED_FIXES + 5; index++) {
    rows = applyFixMessage(rows, { ...APPLIED_FIX, fix: { ...APPLIED_FIX.fix, line: index } });
  }
  assert.equal(rows.length, MAX_RENDERED_FIXES);
  assert.equal(rows[0].line, MAX_RENDERED_FIXES + 4);
});

test('a raised hand outranks unseen arrivals, and stands even while the panel is open', async () => {
  const { decideVisionsAttention, VISIONS_ATTENTION_HAND, VISIONS_ATTENTION_UNSEEN } = await importCore();

  assert.equal(decideVisionsAttention({ unseen: false, handCount: 0 }), null);
  assert.equal(decideVisionsAttention({ unseen: true, handCount: 0 }), VISIONS_ATTENTION_UNSEEN);
  assert.equal(decideVisionsAttention({ unseen: false, handCount: 1 }), VISIONS_ATTENTION_HAND);
  assert.equal(
    decideVisionsAttention({ unseen: true, handCount: 2 }), VISIONS_ATTENTION_HAND,
    'the rarest thing the lane produces must not look like the noisiest',
  );
  assert.equal(decideVisionsAttention(), null, 'no state is no ask');
});
