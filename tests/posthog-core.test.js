'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  issueKey,
  issueUrl,
  classifyIssueChange,
  planInvestigations,
  decideVanishedEntry,
  pingFor,
  nextState,
  displayTitle,
  MAX_PING_TITLE_CHARS,
} = require('../server/core/posthog-core');

function makeIssue(overrides = {}) {
  return {
    issueId: 'iss-1',
    title: 'TypeError: cannot read x of undefined',
    status: 'active',
    occurrences: 120,
    users: 8,
    firstSeen: '2026-08-01T00:00:00Z',
    lastSeen: '2026-08-09T00:00:00Z',
    ...overrides,
  };
}

function makeEntry(overrides = {}) {
  return {
    status: 'active',
    lastOccurrences: 100,
    lastUsers: 5,
    lastSeen: '2026-08-08T00:00:00Z',
    investigatedAt: null,
    investigatedUsers: null,
    verdict: null,
    inFlight: false,
    pingedPhases: [],
    ...overrides,
  };
}

test('issueKey strips the protocol and joins host/project#issue', () => {
  assert.equal(issueKey('https://eu.posthog.com', 123, 'iss-1'), 'eu.posthog.com/123#iss-1');
  assert.equal(issueKey('http://ph.local/', 7, 'a'), 'ph.local/7#a');
});

test('issueUrl keeps the protocol and points at the error-tracking page', () => {
  assert.equal(issueUrl('https://eu.posthog.com/', 123, 'iss-1'), 'https://eu.posthog.com/project/123/error_tracking/iss-1');
});

test('classifyIssueChange: an id named by a fresh spike event is spiking', () => {
  const change = classifyIssueChange(makeEntry(), makeIssue(), new Set(['iss-1']), {});
  assert.equal(change, 'spiking');
});

test('classifyIssueChange: spiking outranks regressed', () => {
  const prev = makeEntry({ status: 'resolved' });
  assert.equal(classifyIssueChange(prev, makeIssue(), new Set(['iss-1']), {}), 'spiking');
});

test('classifyIssueChange: resolved -> active is regressed', () => {
  const prev = makeEntry({ status: 'resolved' });
  assert.equal(classifyIssueChange(prev, makeIssue(), new Set(), {}), 'regressed');
});

test('classifyIssueChange: no prior entry and active is new', () => {
  assert.equal(classifyIssueChange(undefined, makeIssue(), new Set(), {}), 'new');
});

test('classifyIssueChange: no prior entry but already resolved is quiet', () => {
  assert.equal(classifyIssueChange(undefined, makeIssue({ status: 'resolved' }), new Set(), {}), 'quiet');
});

test('classifyIssueChange: crossing the user threshold after a verdict is worsened', () => {
  const prev = makeEntry({ verdict: 'ROOT_CAUSE', investigatedUsers: 4 });
  const change = classifyIssueChange(prev, makeIssue({ users: 40 }), new Set(), { userEscalationThreshold: 25 });
  assert.equal(change, 'worsened');
});

test('classifyIssueChange: crossing the threshold without a prior verdict is quiet', () => {
  const prev = makeEntry({ verdict: null, investigatedUsers: 4 });
  const change = classifyIssueChange(prev, makeIssue({ users: 40 }), new Set(), { userEscalationThreshold: 25 });
  assert.equal(change, 'quiet');
});

test('classifyIssueChange: already over the threshold when investigated does not re-fire worsened', () => {
  const prev = makeEntry({ verdict: 'NEEDS_HUMAN', investigatedUsers: 30 });
  const change = classifyIssueChange(prev, makeIssue({ users: 40 }), new Set(), { userEscalationThreshold: 25 });
  assert.equal(change, 'quiet');
});

test('classifyIssueChange: an unchanged known issue is quiet', () => {
  assert.equal(classifyIssueChange(makeEntry(), makeIssue(), new Set(), {}), 'quiet');
});

test('planInvestigations: every escalation is investigated regardless of user count', () => {
  const changes = [
    { key: 'k1', change: 'spiking', issue: makeIssue({ users: 0 }) },
    { key: 'k2', change: 'regressed', issue: makeIssue({ users: 0 }) },
    { key: 'k3', change: 'worsened', issue: makeIssue({ users: 0 }) },
  ];
  assert.deepEqual(planInvestigations(changes, {}, { minUsersToInvestigate: 5 }), changes);
});

test('planInvestigations: a new issue must clear minUsersToInvestigate', () => {
  const under = { key: 'k1', change: 'new', issue: makeIssue({ users: 1 }) };
  const over = { key: 'k2', change: 'new', issue: makeIssue({ users: 5 }) };
  assert.deepEqual(planInvestigations([under, over], {}, { minUsersToInvestigate: 5 }), [over]);
});

test('planInvestigations: default minUsers of 1 keeps a single-user new issue', () => {
  const change = { key: 'k1', change: 'new', issue: makeIssue({ users: 1 }) };
  assert.deepEqual(planInvestigations([change], {}, {}), [change]);
});

test('planInvestigations: a quiet issue is never investigated', () => {
  const change = { key: 'k1', change: 'quiet', issue: makeIssue({ users: 900 }) };
  assert.deepEqual(planInvestigations([change], {}, {}), []);
});

test('planInvestigations: an entry already inFlight is skipped', () => {
  const change = { key: 'k1', change: 'spiking', issue: makeIssue() };
  assert.deepEqual(planInvestigations([change], { k1: makeEntry({ inFlight: true }) }, {}), []);
});

// A spike classification repeats for as long as the spike endpoint names the issue, so an
// unconditional re-investigation was one Claude session per interval, forever, per issue.
test('planInvestigations: an already diagnosed spiking issue is not re-investigated', () => {
  const change = { key: 'k1', change: 'spiking', issue: makeIssue({ users: 8 }) };
  const state = { k1: makeEntry({ verdict: 'ROOT_CAUSE', investigatedUsers: 8 }) };
  assert.deepEqual(planInvestigations([change], state, { userEscalationThreshold: 25 }), []);
});

test('planInvestigations: a diagnosed spiking issue crossing the threshold IS re-investigated', () => {
  const change = { key: 'k1', change: 'spiking', issue: makeIssue({ users: 40 }) };
  const state = { k1: makeEntry({ verdict: 'ROOT_CAUSE', investigatedUsers: 8 }) };
  assert.deepEqual(planInvestigations([change], state, { userEscalationThreshold: 25 }), [change]);
});

test('planInvestigations: a spiking issue with no verdict yet is always investigated', () => {
  const change = { key: 'k1', change: 'spiking', issue: makeIssue({ users: 0 }) };
  const state = { k1: makeEntry({ verdict: null }) };
  assert.deepEqual(planInvestigations([change], state, { userEscalationThreshold: 25 }), [change]);
});

// --- decideVanishedEntry: absence from one top-50 query is not death ---

const DAY_MS = 86400000;

test('decideVanishedEntry: an in-flight entry is kept, never touched mid-investigation', () => {
  assert.equal(decideVanishedEntry(makeEntry({ inFlight: true }), 10 * DAY_MS, {}), 'keep');
});

test('decideVanishedEntry: a first absence is marked resolved, not pruned', () => {
  assert.equal(decideVanishedEntry(makeEntry(), 1000, {}), 'resolve');
});

test('decideVanishedEntry: an already-resolved entry inside the window is kept', () => {
  const entry = makeEntry({ status: 'resolved', vanishedAt: 1000 });
  assert.equal(decideVanishedEntry(entry, 1000 + 6 * DAY_MS, {}), 'keep');
});

test('decideVanishedEntry: past the retention window it is pruned', () => {
  const entry = makeEntry({ status: 'resolved', vanishedAt: 1000 });
  assert.equal(decideVanishedEntry(entry, 1000 + 7 * DAY_MS, {}), 'prune');
  assert.equal(decideVanishedEntry(entry, 1000 + 2 * DAY_MS, { entryRetentionDays: 1 }), 'prune');
});

test('decideVanishedEntry: a missing entry is prunable', () => {
  assert.equal(decideVanishedEntry(undefined, 1000, {}), 'prune');
});

const PING_CTX = {
  projectName: 'web',
  title: 'TypeError: boom',
  occurrences: 120,
  users: 8,
  url: 'https://eu.posthog.com/project/1/error_tracking/iss-1',
};

test('pingFor: spike renders the lane tag, label, title, counts and url', () => {
  const msg = pingFor('spike', PING_CTX);
  assert.equal(msg, [
    '[glissa/posthog] SPIKE web',
    'TypeError: boom',
    '120 occurrences / 8 users',
    'https://eu.posthog.com/project/1/error_tracking/iss-1',
  ].join('\n'));
});

test('pingFor: each pinging kind renders its own label', () => {
  assert.match(pingFor('regression', PING_CTX), /^\[glissa\/posthog\] REGRESSED web$/m);
  assert.match(pingFor('needs_human', PING_CTX), /^\[glissa\/posthog\] NEEDS HUMAN web$/m);
  assert.match(pingFor('error', PING_CTX), /^\[glissa\/posthog\] ERROR web$/m);
  assert.match(pingFor('new_high_impact', PING_CTX), /^\[glissa\/posthog\] HIGH IMPACT web$/m);
});

// A title is an end-user error message reaching Telegram verbatim, so it is flattened (a newline
// could otherwise forge the lane-tag header line) and capped.
test('displayTitle flattens whitespace and caps the length', () => {
  assert.equal(displayTitle('  Type\nError:   boom  '), 'Type Error: boom');
  const long = displayTitle('x'.repeat(1000));
  assert.equal(long.length, MAX_PING_TITLE_CHARS);
  assert.ok(long.endsWith('...'));
});

test('pingFor truncates a crafted huge title instead of sending it whole', () => {
  const msg = pingFor('spike', { ...PING_CTX, title: 'y'.repeat(5000) });
  assert.equal(msg.split('\n')[1].length, MAX_PING_TITLE_CHARS);
});

test('pingFor: a title carrying newlines cannot forge extra message lines', () => {
  const msg = pingFor('spike', { ...PING_CTX, title: 'boom\n[glissa/posthog] SPIKE fake' });
  assert.equal(msg.split('\n').length, 4);
});

test('pingFor: root_cause is digest-only and never pings', () => {
  assert.equal(pingFor('root_cause', PING_CTX), null);
});

test('pingFor: an unknown kind returns null', () => {
  assert.equal(pingFor('whatever', PING_CTX), null);
});

test('nextState: an observation records the aggregates and carries prior verdict fields forward', () => {
  const prev = makeEntry({ verdict: 'ROOT_CAUSE', investigatedAt: 111, investigatedUsers: 5, pingedPhases: ['needs_human'] });
  const entry = nextState(prev, makeIssue({ occurrences: 300, users: 12 }), {});
  assert.equal(entry.lastOccurrences, 300);
  assert.equal(entry.lastUsers, 12);
  assert.equal(entry.status, 'active');
  assert.equal(entry.verdict, 'ROOT_CAUSE', 'a plain observation does not clear the verdict');
  assert.equal(entry.investigatedAt, 111);
  assert.equal(entry.investigatedUsers, 5);
  assert.equal(entry.inFlight, false);
  assert.deepEqual(entry.pingedPhases, ['needs_human']);
});

test('nextState: a verdict stamps investigatedAt/investigatedUsers from the passed clock', () => {
  const entry = nextState(makeEntry(), makeIssue({ users: 12 }), { verdict: 'NEEDS_HUMAN', at: 999 });
  assert.equal(entry.verdict, 'NEEDS_HUMAN');
  assert.equal(entry.investigatedAt, 999);
  assert.equal(entry.investigatedUsers, 12);
});

test('nextState: inFlight is opt-in and pingedPhases can be replaced', () => {
  const entry = nextState(makeEntry(), makeIssue(), { inFlight: true, pingedPhases: ['error'] });
  assert.equal(entry.inFlight, true);
  assert.deepEqual(entry.pingedPhases, ['error']);
});

test('nextState: a first sighting with no prior entry defaults cleanly', () => {
  const entry = nextState(undefined, makeIssue(), {});
  assert.equal(entry.verdict, null);
  assert.equal(entry.investigatedAt, null);
  assert.equal(entry.investigatedUsers, null);
  assert.deepEqual(entry.pingedPhases, []);
});
