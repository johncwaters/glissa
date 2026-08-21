'use strict';

// Connect-time replay of a cached startup update-check result. A control client connecting AFTER the
// check resolved must receive one 'update-available' frame; the accessor is guarded so the four existing
// control-WS tests (which register handlers WITHOUT getUpdateStatus) never throw on connection. The
// same cached-snapshot replay covers the two background lanes (posthog-status, pr-status).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');

function connect(deps) {
  const controlWss = new EventEmitter();
  const sent = [];
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: () => {} };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [], teams: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: () => {},
    ...deps,
  });
  controlWss.emit('connection', ws);
  return sent;
}

test('no update-available when getUpdateStatus is absent (does not throw)', () => {
  let sent;
  assert.doesNotThrow(() => { sent = connect({}); });
  assert.equal(sent.filter((m) => m.type === 'update-available').length, 0);
});

test('no update-available when getUpdateStatus reports no update', () => {
  const sent = connect({ getUpdateStatus: () => ({ updateAvailable: false }) });
  assert.equal(sent.filter((m) => m.type === 'update-available').length, 0);
});

test('replays exactly one update-available frame when an update is cached', () => {
  const status = {
    updateAvailable: true,
    current: '0.16.0',
    latest: '0.17.0',
    currentSha: '0123456789abcdef0123456789abcdef01234567',
    latestSha: 'fedcba9876543210fedcba9876543210fedcba98',
    compareUrl: 'https://github.com/johncwaters/glissa/compare/0123456789abcdef0123456789abcdef01234567...main',
    command: 'npm install -g github:johncwaters/glissa --allow-git=root',
    flavor: 'npm-global',
  };
  const sent = connect({ getUpdateStatus: () => status });
  const updates = sent.filter((m) => m.type === 'update-available');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { type: 'update-available', ...status });
});

// --- Connect-time replay of the cached lane snapshots (PostHog, PR auto-review) ---

const PR_STATUS = {
  type: 'pr-status',
  ts: 1000,
  projects: [{
    projectId: 'p1',
    name: 'My Repo',
    repoSlug: 'me/repo',
    lastTickAt: 1000,
    prs: [{
      key: 'me/repo#7',
      number: 7,
      title: 'Fix the thing',
      url: 'https://github.com/me/repo/pull/7',
      headSha: 'sha1',
      phase: 'awaiting-checks',
      inFlight: false,
      wasConflicting: false,
      pingedError: false,
    }],
  }],
};

test('no pr-status when getPrStatus is absent (does not throw)', () => {
  let sent;
  assert.doesNotThrow(() => { sent = connect({}); });
  assert.equal(sent.filter((m) => m.type === 'pr-status').length, 0);
});

test('no pr-status when no tick has completed yet', () => {
  const sent = connect({ getPrStatus: () => null });
  assert.equal(sent.filter((m) => m.type === 'pr-status').length, 0);
});

test('replays exactly one pr-status frame from the cached tick summary', () => {
  const sent = connect({ getPrStatus: () => PR_STATUS });
  const frames = sent.filter((m) => m.type === 'pr-status');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], PR_STATUS);
});

test('the posthog and pr lane snapshots replay independently', () => {
  const posthogStatus = { type: 'posthog-status', ts: 1000, projects: [] };
  const sent = connect({ getPosthogStatus: () => posthogStatus, getPrStatus: () => PR_STATUS });
  assert.deepEqual(sent.filter((m) => m.type === 'posthog-status'), [posthogStatus]);
  assert.deepEqual(sent.filter((m) => m.type === 'pr-status'), [PR_STATUS]);
});
