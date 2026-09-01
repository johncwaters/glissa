import test from 'node:test';
import assert from 'node:assert/strict';

import {
  distinctiveTokens,
  jaccard,
  scoreAgainstPrior,
  findRecurrenceMatch,
  escalationReason,
  decideRecurrence,
  planIssueActions,
  recordTransientSignature,
  noteRecurrence,
  pruneSignatures,
  signatureRecords,
  recurrenceSummaryLine,
  escalationDetail,
  SIGNATURES_KEY,
  SIGNATURE_CAP,
  DEFAULT_RECURRENCE_WINDOW_DAYS,
  DEFAULT_TRANSIENT_RECURRENCE_LIMIT,
} from '../server/core/posthog-recurrence.ts';

const DAY_MS = 86400000;
const NOW = 10 * DAY_MS;

const CHUNK_TITLE_A = 'TypeError: Failed to fetch dynamically imported module: https://shop.example.com/assets/maplibre-gl-B3nQ.js';
const CHUNK_TITLE_B = 'TypeError: Failed to fetch dynamically imported module: https://shop.example.com/assets/maplibre-gl-Zk91.js';

function makeIssue(over = {}) {
  return {
    issueId: 'iss-2',
    title: CHUNK_TITLE_B,
    status: 'active',
    occurrences: 3,
    users: 1,
    ...over,
  };
}

function makeChange(over: { issue?: Record<string, unknown>; change?: string; key?: string } = {}) {
  return {
    key: 'ph.test/1#iss-2',
    projectId: 1,
    projectName: 'shop',
    change: 'new',
    ...over,
    issue: makeIssue(over.issue),
  };
}

function stateWithPrior(over = {}) {
  return {
    [SIGNATURES_KEY]: {
      'ph.test/1#iss-1': {
        projectId: '1',
        issueId: 'iss-1',
        title: CHUNK_TITLE_A,
        summaryLine: 'A crawler failed to lazy-load the map chunk; no code defect.',
        firstAt: NOW - DAY_MS,
        lastAt: NOW - DAY_MS,
        recurrences: 0,
        escalated: false,
        recurredIssueIds: [],
        ...over,
      },
    },
  };
}

const OPTS = { now: NOW, recurrenceWindowDays: DEFAULT_RECURRENCE_WINDOW_DAYS, transientRecurrenceLimit: DEFAULT_TRANSIENT_RECURRENCE_LIMIT };

test('distinctiveTokens lowercases, splits on punctuation, and dedupes', () => {
  assert.deepEqual(distinctiveTokens('Checkout-Widget: checkout WIDGET boom'), ['checkout', 'widget', 'boom']);
});

test('distinctiveTokens drops boilerplate, short fragments, digits, hex ids and build hashes', () => {
  assert.deepEqual(distinctiveTokens('TypeError: Cannot read properties of undefined'), ['typeerror']);
  assert.deepEqual(distinctiveTokens('failed 42 x ab12cd34ef56 maplibre B3nQ'), ['maplibre']);
});

test('distinctiveTokens accepts several texts and keeps first-seen order', () => {
  assert.deepEqual(distinctiveTokens('checkout boom', 'boom widget'), ['checkout', 'boom', 'widget']);
});

test('jaccard is union-based, so a subset never scores a free 1.0', () => {
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard(['a'], ['a', 'b', 'c']), 1 / 3);
  assert.equal(jaccard([], ['a']), 0);
});

test('scoreAgainstPrior matches the same non-event across a deploy that changed the asset hash', () => {
  const scored = scoreAgainstPrior(distinctiveTokens(CHUNK_TITLE_B), { title: CHUNK_TITLE_A });
  assert.equal(scored.matched, true);
  assert.ok(scored.score >= 0.6, `score ${scored.score}`);
});

test('scoreAgainstPrior refuses two unrelated errors that share only their error type', () => {
  const scored = scoreAgainstPrior(
    distinctiveTokens('TypeError: checkout widget exploded during payment capture'),
    { title: 'TypeError: avatar uploader rejected the profile image' },
  );
  assert.equal(scored.matched, false);
});

test('scoreAgainstPrior refuses a prior whose title is pure boilerplate', () => {
  const scored = scoreAgainstPrior(
    distinctiveTokens('TypeError: Cannot read properties of undefined'),
    { title: 'TypeError: Cannot read properties of undefined' },
  );
  assert.equal(scored.matched, false, 'identical boilerplate is not evidence of the same incident');
});

test('scoreAgainstPrior enforces the absolute shared-token floor over the ratio', () => {
  const scored = scoreAgainstPrior(distinctiveTokens('alpha beta gamma'), { title: 'alpha beta gamma' });
  assert.equal(scored.shared, 3);
  assert.equal(scored.matched, true);
  const twoShared = scoreAgainstPrior(distinctiveTokens('alpha beta delta'), { title: 'alpha beta gamma' });
  assert.ok(twoShared.score >= 0.5, 'the ratio alone would have passed the corroborated threshold');
  assert.equal(twoShared.matched, false, 'two shared tokens is never enough');
});

test('a prior summary sharing distinctive tokens lowers the threshold, never the token floor', () => {
  const candidate = distinctiveTokens('checkout widget stripe timeout during capture retry');
  const prior = { title: 'checkout widget stripe timeout' };
  const bare = scoreAgainstPrior(candidate, prior);
  const corroborated = scoreAgainstPrior(candidate, { ...prior, summaryLine: 'The stripe capture retry timed out.' });
  assert.equal(bare.matched, false, `bare score ${bare.score} is below the plain threshold`);
  assert.equal(corroborated.matched, true);
  assert.equal(corroborated.threshold, 0.5);
});

test('findRecurrenceMatch finds the prior transient of the same project', () => {
  const matchOrNull = findRecurrenceMatch(
    { title: CHUNK_TITLE_B, projectId: 1, key: 'ph.test/1#iss-2' },
    stateWithPrior(),
    NOW,
    OPTS,
  );
  assert.equal(matchOrNull?.key, 'ph.test/1#iss-1');
  assert.equal(matchOrNull?.record.issueId, 'iss-1');
});

test('findRecurrenceMatch ignores a prior from another PostHog project', () => {
  const state = stateWithPrior({ projectId: '2' });
  assert.equal(findRecurrenceMatch({ title: CHUNK_TITLE_B, projectId: 1 }, state, NOW, OPTS), null);
});

test('findRecurrenceMatch ignores a prior older than the recency window', () => {
  const state = stateWithPrior({ lastAt: NOW - (8 * DAY_MS) });
  assert.equal(findRecurrenceMatch({ title: CHUNK_TITLE_B, projectId: 1 }, state, NOW, OPTS), null);
  const wider = findRecurrenceMatch({ title: CHUNK_TITLE_B, projectId: 1 }, state, NOW, { ...OPTS, recurrenceWindowDays: 30 });
  assert.equal(wider?.key, 'ph.test/1#iss-1', 'a wider window reaches it');
});

test('findRecurrenceMatch never matches an issue against its own cluster record', () => {
  const state = stateWithPrior();
  assert.equal(findRecurrenceMatch({ title: CHUNK_TITLE_A, projectId: 1, key: 'ph.test/1#iss-1' }, state, NOW, OPTS), null);
});

test('findRecurrenceMatch refuses a candidate with too few distinctive tokens', () => {
  assert.equal(findRecurrenceMatch({ title: 'TypeError: undefined', projectId: 1 }, stateWithPrior(), NOW, OPTS), null);
});

test('findRecurrenceMatch on an empty or missing registry is null, never a throw', () => {
  assert.equal(findRecurrenceMatch({ title: CHUNK_TITLE_B, projectId: 1 }, {}, NOW, OPTS), null);
  assert.equal(findRecurrenceMatch({ title: CHUNK_TITLE_B, projectId: 1 }, { [SIGNATURES_KEY]: 'junk' }, NOW, OPTS), null);
});

test('findRecurrenceMatch picks the highest score, then the most recent, deterministically', () => {
  const state = {
    [SIGNATURES_KEY]: {
      old: {
        projectId: '1', issueId: 'iss-old', title: CHUNK_TITLE_A, lastAt: NOW - (2 * DAY_MS), recurrences: 4,
      },
      recent: {
        projectId: '1', issueId: 'iss-recent', title: CHUNK_TITLE_A, lastAt: NOW - 1000, recurrences: 1,
      },
    },
  };
  const matchOrNull = findRecurrenceMatch({ title: CHUNK_TITLE_B, projectId: 1 }, state, NOW, OPTS);
  assert.equal(matchOrNull?.record.issueId, 'iss-recent', 'equal scores break toward the fresher cluster');
});

test('escalationReason: the configured repeat escalates, the one before it does not', () => {
  const change = makeChange();
  assert.equal(escalationReason(change, 2, OPTS), null);
  assert.equal(escalationReason(change, 3, OPTS), 'limit');
  assert.equal(escalationReason(change, 2, { ...OPTS, transientRecurrenceLimit: 2 }), 'limit');
});

test('escalationReason: more than one affected user escalates', () => {
  assert.equal(escalationReason(makeChange({ issue: { users: 2 } }), 1, OPTS), 'users');
  assert.equal(escalationReason(makeChange({ issue: { users: 1 } }), 1, OPTS), null);
});

test('escalationReason: a spiking classification escalates', () => {
  assert.equal(escalationReason(makeChange({ change: 'spiking' }), 1, OPTS), 'spike');
});

test('escalationReason: a zero or missing limit falls back to the default rather than escalating everything', () => {
  assert.equal(escalationReason(makeChange(), 1, { transientRecurrenceLimit: 0 }), null);
  assert.equal(escalationReason(makeChange(), 3, {}), 'limit');
});

test('decideRecurrence: a confident match against a fresh transient dedupes', () => {
  const decision = decideRecurrence(makeChange(), stateWithPrior(), OPTS);
  assert.equal(decision.action, 'dedupe');
  assert.equal(decision.reason, 'prior-transient');
  assert.equal(decision.matchKey, 'ph.test/1#iss-1');
  assert.equal(decision.matchIssueId, 'iss-1');
  assert.equal(decision.ordinal, 1);
});

test('decideRecurrence: the ordinal counts on from the cluster', () => {
  const decision = decideRecurrence(makeChange(), stateWithPrior({ recurrences: 1 }), OPTS);
  assert.equal(decision.action, 'dedupe');
  assert.equal(decision.ordinal, 2);
});

test('decideRecurrence: the third repeat escalates instead of deduping', () => {
  const decision = decideRecurrence(makeChange(), stateWithPrior({ recurrences: 2 }), OPTS);
  assert.equal(decision.action, 'escalate');
  assert.equal(decision.reason, 'limit');
  assert.equal(decision.ordinal, 3);
});

test('decideRecurrence: more than one affected user escalates on the first repeat', () => {
  const decision = decideRecurrence(makeChange({ issue: { users: 4 } }), stateWithPrior(), OPTS);
  assert.equal(decision.action, 'escalate');
  assert.equal(decision.reason, 'users');
});

test('decideRecurrence: a spiking repeat escalates and is never deduped', () => {
  const decision = decideRecurrence(makeChange({ change: 'spiking' }), stateWithPrior(), OPTS);
  assert.equal(decision.action, 'escalate');
  assert.equal(decision.reason, 'spike');
});

test('decideRecurrence: an escalated cluster is never deduped into again, and never re-pings', () => {
  const decision = decideRecurrence(makeChange(), stateWithPrior({ escalated: true }), OPTS);
  assert.equal(decision.action, 'spawn');
  assert.equal(decision.reason, 'escalated-cluster');
});

test('decideRecurrence: the kill switch restores plain spawning', () => {
  const decision = decideRecurrence(makeChange(), stateWithPrior(), { ...OPTS, recurrenceDedupe: false });
  assert.deepEqual(decision, { action: 'spawn', reason: 'disabled', matchKey: null, matchIssueId: null, ordinal: 0, score: 0 });
});

test('decideRecurrence: only a first investigation of an id is eligible', () => {
  for (const change of ['regressed', 'worsened', 'quiet']) {
    const decision = decideRecurrence(makeChange({ change }), stateWithPrior(), OPTS);
    assert.equal(decision.action, 'spawn', `${change} is never deduped`);
    assert.equal(decision.reason, 'not-eligible');
  }
});

test('decideRecurrence: an issue that already carries its own verdict is never deduped', () => {
  const state = { ...stateWithPrior(), 'ph.test/1#iss-2': { verdict: 'ROOT_CAUSE' } };
  const decision = decideRecurrence(makeChange(), state, OPTS);
  assert.equal(decision.action, 'spawn');
  assert.equal(decision.reason, 'own-verdict');
});

test('decideRecurrence: no prior at all spawns, which is the pre-feature behavior', () => {
  const decision = decideRecurrence(makeChange(), {}, OPTS);
  assert.equal(decision.action, 'spawn');
  assert.equal(decision.reason, 'no-match');
});

test('decideRecurrence: an unrelated error with a prior in state still spawns', () => {
  const change = makeChange({ issue: { title: 'RangeError: invoice pagination cursor out of bounds' } });
  assert.equal(decideRecurrence(change, stateWithPrior(), OPTS).action, 'spawn');
});

test('planIssueActions splits a plan into spawns and dedupes and drops what earns no attention', () => {
  const changes = [
    makeChange(),
    makeChange({ key: 'ph.test/1#iss-3', change: 'quiet', issue: { issueId: 'iss-3' } }),
    makeChange({ key: 'ph.test/1#iss-4', issue: { issueId: 'iss-4', title: 'RangeError: invoice pagination cursor out of bounds' } }),
  ];
  const plan = planIssueActions(changes, stateWithPrior(), OPTS);
  assert.deepEqual(plan.dedupe.map((i) => i.change.key), ['ph.test/1#iss-2']);
  assert.deepEqual(plan.investigate.map((i) => i.change.key), ['ph.test/1#iss-4']);
});

test('planIssueActions keeps core.planInvestigations gating: an in-flight entry is skipped', () => {
  const state = { ...stateWithPrior(), 'ph.test/1#iss-2': { inFlight: true } };
  const plan = planIssueActions([makeChange()], state, OPTS);
  assert.deepEqual(plan.dedupe, []);
  assert.deepEqual(plan.investigate, []);
});

test('planIssueActions carries the escalation decision alongside the change', () => {
  const plan = planIssueActions([makeChange()], stateWithPrior({ recurrences: 2 }), OPTS);
  assert.equal(plan.investigate[0].recurrence.action, 'escalate');
  assert.equal(plan.investigate[0].recurrence.ordinal, 3);
});

test('recordTransientSignature opens a cluster and normalizes it', () => {
  const registry = recordTransientSignature({}, {
    key: 'ph.test/1#iss-1', projectId: 1, issueId: 'iss-1', title: CHUNK_TITLE_A, summaryLine: 'crawler', at: NOW,
  });
  assert.deepEqual(registry['ph.test/1#iss-1'], {
    projectId: '1',
    issueId: 'iss-1',
    title: CHUNK_TITLE_A,
    summaryLine: 'crawler',
    firstAt: NOW,
    lastAt: NOW,
    recurrences: 0,
    escalated: false,
    recurredIssueIds: [],
  });
});

test('recordTransientSignature refreshes an existing cluster without resetting its counter or title', () => {
  const state = stateWithPrior({ recurrences: 2, escalated: true });
  const registry = recordTransientSignature(state, {
    key: 'ph.test/1#iss-1', projectId: 1, issueId: 'iss-9', title: 'something else entirely', at: NOW,
  });
  assert.equal(registry['ph.test/1#iss-1'].recurrences, 2);
  assert.equal(registry['ph.test/1#iss-1'].escalated, true);
  assert.equal(registry['ph.test/1#iss-1'].title, CHUNK_TITLE_A);
  assert.equal(registry['ph.test/1#iss-1'].lastAt, NOW);
  assert.equal(state[SIGNATURES_KEY]['ph.test/1#iss-1'].lastAt, NOW - DAY_MS, 'the input registry is untouched');
});

test('recordTransientSignature without a key is a no-op', () => {
  assert.deepEqual(recordTransientSignature(stateWithPrior(), { at: NOW }), signatureRecords(stateWithPrior()));
});

test('noteRecurrence increments the counter on the prior, records the id, and can latch escalated', () => {
  const registry = noteRecurrence(stateWithPrior(), 'ph.test/1#iss-1', { at: NOW, issueId: 'iss-2' });
  assert.equal(registry['ph.test/1#iss-1'].recurrences, 1);
  assert.equal(registry['ph.test/1#iss-1'].lastAt, NOW);
  assert.deepEqual(registry['ph.test/1#iss-1'].recurredIssueIds, ['iss-2']);
  assert.equal(registry['ph.test/1#iss-1'].escalated, false);

  const escalated = noteRecurrence({ [SIGNATURES_KEY]: registry }, 'ph.test/1#iss-1', { at: NOW, issueId: 'iss-3', escalated: true });
  assert.equal(escalated['ph.test/1#iss-1'].recurrences, 2);
  assert.equal(escalated['ph.test/1#iss-1'].escalated, true);
});

test('noteRecurrence never un-escalates a cluster and ignores an unknown key', () => {
  const state = { [SIGNATURES_KEY]: noteRecurrence(stateWithPrior({ escalated: true }), 'ph.test/1#iss-1', { at: NOW }) };
  assert.equal(noteRecurrence(state, 'ph.test/1#iss-1', { at: NOW })['ph.test/1#iss-1'].escalated, true);
  assert.deepEqual(noteRecurrence(stateWithPrior(), 'nope', { at: NOW }), signatureRecords(stateWithPrior()));
});

test('noteRecurrence caps the remembered issue ids', () => {
  let registry = signatureRecords(stateWithPrior());
  for (let i = 0; i < 15; i += 1) {
    registry = noteRecurrence({ [SIGNATURES_KEY]: registry }, 'ph.test/1#iss-1', { at: NOW, issueId: `iss-${i}` });
  }
  assert.equal(registry['ph.test/1#iss-1'].recurrences, 15);
  assert.equal(registry['ph.test/1#iss-1'].recurredIssueIds.length, 10);
  assert.equal(registry['ph.test/1#iss-1'].recurredIssueIds[9], 'iss-14');
});

test('pruneSignatures drops clusters past the window and caps the rest', () => {
  const stale = stateWithPrior({ lastAt: NOW - (9 * DAY_MS) });
  assert.deepEqual(pruneSignatures(stale, NOW, OPTS), {});
  assert.deepEqual(Object.keys(pruneSignatures(stateWithPrior(), NOW, OPTS)), ['ph.test/1#iss-1']);

  const many = {};
  for (let i = 0; i < SIGNATURE_CAP + 20; i += 1) {
    (many as Record<string, unknown>)[`k${i}`] = { projectId: '1', issueId: `iss-${i}`, title: CHUNK_TITLE_A, lastAt: NOW - i };
  }
  const pruned = pruneSignatures({ [SIGNATURES_KEY]: many }, NOW, OPTS);
  assert.equal(Object.keys(pruned).length, SIGNATURE_CAP);
  assert.ok(pruned.k0, 'the newest survives');
});

test('pruneSignatures on a missing registry returns an empty object', () => {
  assert.deepEqual(pruneSignatures({}, NOW, OPTS), {});
});

test('recurrenceSummaryLine names the prior issue it reused', () => {
  assert.equal(
    recurrenceSummaryLine({ matchIssueId: 'iss-1', ordinal: 2 }),
    'TRANSIENT by recurrence: matches prior transient issue iss-1 (repeat 2); no investigation spawned',
  );
});

test('escalationDetail explains which trigger stopped the old verdict being reused', () => {
  const base = { ordinal: 3, matchIssueId: 'iss-1', recurrenceWindowDays: 7 };
  assert.equal(escalationDetail({ ...base, reason: 'limit' }), 'recurring transient escalated: repeat 3 within 7 days of issue iss-1');
  assert.match(escalationDetail({ ...base, reason: 'users' }), /more than one user$/);
  assert.match(escalationDetail({ ...base, reason: 'spike' }), /spiking$/);
});
