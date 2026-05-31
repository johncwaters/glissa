'use strict';

// Verifies the team control-WS handlers dispatch correctly. A fake controlWss (EventEmitter) and a
// fake ws capture the message handler and the JSON the server sends back; team collaborators
// (registry/orchestrator/teamOutput) are injected as fakes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../control-handlers');
const { loadTeam } = require('../teamlib/team-registry');

const REPO_TEAMS = path.join(__dirname, '..', 'teams');

function harness(depsOverride = {}) {
  const controlWss = new EventEmitter();
  const sent = [];
  let messageHandler = null;
  const ws = {
    send: (s) => sent.push(JSON.parse(s)),
    on: (ev, h) => { if (ev === 'message') messageHandler = h; },
  };
  const savedConfig = { projects: [], teams: [] };
  const deps = {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: {
      save: (fn) => { fn(savedConfig); return savedConfig; },
      getSettings: () => ({}),
    },
    broadcastControl: () => {},
    ...depsOverride,
  };
  registerControlHandlers(controlWss, deps);
  controlWss.emit('connection', ws);
  sent.length = 0; // drop the initial snapshot
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent, savedConfig };
}

const realRegistry = {
  listTeams: () => ['marketing'],
  loadTeam: (id) => loadTeam(id, REPO_TEAMS),
};

test('list-teams returns the roster with ordered stage ids', () => {
  const h = harness({ registry: realRegistry });
  h.send({ type: 'list-teams', requestId: 'r1' });
  const msg = h.sent.find((m) => m.type === 'teams');
  assert.ok(msg, 'sent a teams message');
  assert.equal(msg.requestId, 'r1');
  const mkt = msg.teams.find((t) => t.id === 'marketing');
  assert.deepEqual(mkt.stages, ['researcher', 'strategist', 'writer', 'editor', 'publisher']);
});

test('run-team invokes the orchestrator with a manual trigger and acks', () => {
  const calls = [];
  const orchestrator = {
    isActive: () => false,
    runTeam: (args) => { calls.push(args); return Promise.resolve({ ok: true }); },
  };
  const h = harness({ orchestrator });
  h.send({ type: 'run-team', teamId: 'marketing', projectId: 'p1' });
  assert.ok(h.sent.some((m) => m.type === 'team-run-accepted'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trigger, 'manual');
  assert.equal(calls[0].projectId, 'p1');
});

test('run-team is skipped when a run is already active', () => {
  const orchestrator = { isActive: () => true, runTeam: () => assert.fail('should not run') };
  const h = harness({ orchestrator });
  h.send({ type: 'run-team', teamId: 'marketing', projectId: 'p1' });
  assert.ok(h.sent.some((m) => m.type === 'team-run-skipped' && m.reason === 'already-active'));
});

test('cancel-team-run acks the orchestrator result', () => {
  const orchestrator = { cancelRun: () => true };
  const h = harness({ orchestrator });
  h.send({ type: 'cancel-team-run', teamId: 'marketing', projectId: 'p1' });
  const ack = h.sent.find((m) => m.type === 'team-run-cancel-ack');
  assert.equal(ack.cancelled, true);
});

test('get-team-runs returns run summaries + active flag', () => {
  const h = harness({
    registry: realRegistry,
    teamOutput: {
      listRunSummaries: () => [
        { runId: '2026-06-02-tuesday', topic: 'Boondocking', platforms: 'X', verdict: 'SHIP', summary: 'Strong run.', reached: ['researcher', 'editor'] },
      ],
    },
    getProjectPathById: () => 'C:/proj',
    orchestrator: { isActive: () => true },
  });
  h.send({ type: 'get-team-runs', teamId: 'marketing', projectId: 'p1', requestId: 'g1' });
  const msg = h.sent.find((m) => m.type === 'team-runs');
  assert.equal(msg.requestId, 'g1');
  assert.equal(msg.active, true);
  assert.equal(msg.runs.length, 1);
  assert.equal(msg.runs[0].verdict, 'SHIP');
});

test('get-team-runs includes a live snapshot (current stage + timestamps) while active', () => {
  const h = harness({
    registry: realRegistry,
    teamOutput: { listRunSummaries: () => [] },
    getProjectPathById: () => 'C:/proj',
    orchestrator: {
      isActive: () => true,
      getRunState: () => ({ runId: '2026-06-02-tuesday', currentStage: 'writer', runStartedAtMs: 1000, stageStartedAtMs: 2000, cancelling: false }),
    },
  });
  h.send({ type: 'get-team-runs', teamId: 'marketing', projectId: 'p1', requestId: 'g4' });
  const msg = h.sent.find((m) => m.type === 'team-runs');
  assert.equal(msg.active, true);
  assert.ok(msg.live, 'includes a live snapshot so a re-mounting client can rehydrate');
  assert.equal(msg.live.currentStage, 'writer');
  assert.equal(msg.live.stageStartedAtMs, 2000);
  assert.equal(msg.live.cancelling, false);
});

test('get-team-runs omits the live snapshot when no run is active', () => {
  const h = harness({
    registry: realRegistry,
    teamOutput: { listRunSummaries: () => [] },
    getProjectPathById: () => 'C:/proj',
    orchestrator: { isActive: () => false, getRunState: () => assert.fail('must not query run state when inactive') },
  });
  h.send({ type: 'get-team-runs', teamId: 'marketing', projectId: 'p1', requestId: 'g5' });
  const msg = h.sent.find((m) => m.type === 'team-runs');
  assert.equal(msg.active, false);
  assert.equal(msg.live, null);
});

test('set-team-schedule persists an activation and reloads the scheduler', () => {
  let reloaded = null;
  const h = harness({ scheduler: { reload: (teams) => { reloaded = teams; } } });
  h.send({ type: 'set-team-schedule', teamId: 'marketing', projectId: 'p1', enabled: true, schedule: { days: ['tue'], time: '05:00', tz: 'America/Denver' } });
  assert.ok(h.sent.some((m) => m.type === 'team-schedule-updated'));
  const entry = h.savedConfig.teams.find((e) => e.teamId === 'marketing' && e.projectId === 'p1');
  assert.ok(entry && entry.enabled === true);
  assert.ok(Array.isArray(reloaded), 'scheduler.reload was called with the activations');
});

test('run-team reports "not available" when no orchestrator is wired', () => {
  const h = harness({}); // no orchestrator
  h.send({ type: 'run-team', teamId: 'marketing', projectId: 'p1' });
  assert.ok(h.sent.some((m) => m.type === 'error' && /not available/i.test(m.message)));
});

test('get-team-runs reports the effective schedule and a next fire time', () => {
  const h = harness({
    registry: realRegistry,
    teamOutput: { listRunSummaries: () => [] },
    getProjectPathById: () => 'C:/proj',
    orchestrator: { isActive: () => false },
  });
  h.send({ type: 'get-team-runs', teamId: 'marketing', projectId: 'p1', requestId: 'g2' });
  const msg = h.sent.find((m) => m.type === 'team-runs');
  assert.equal(typeof msg.nextFire, 'number', 'marketing has a default schedule, so a next fire computes');
  assert.ok(msg.nextFire > Date.now());
  assert.ok(msg.schedule && Array.isArray(msg.schedule.days), 'returns the effective schedule');
});

test('add-team-instance persists a disabled activation and broadcasts it', () => {
  const broadcasts = [];
  const h = harness({
    registry: realRegistry,
    getProjectPathById: () => 'C:/proj',
    broadcastControl: (m) => broadcasts.push(m),
  });
  h.send({ type: 'add-team-instance', teamId: 'marketing', projectId: 'p1' });
  const entry = h.savedConfig.teams.find((e) => e.teamId === 'marketing' && e.projectId === 'p1');
  assert.ok(entry, 'activation persisted');
  assert.equal(entry.enabled, false, 'created manual-only');
  assert.ok(broadcasts.some((m) => m.type === 'team-instance-added' && m.projectId === 'p1'));
});

test('add-team-instance is idempotent for the same (team, project) pair', () => {
  const h = harness({ registry: realRegistry, getProjectPathById: () => 'C:/proj' });
  h.send({ type: 'add-team-instance', teamId: 'marketing', projectId: 'p1' });
  h.send({ type: 'add-team-instance', teamId: 'marketing', projectId: 'p1' });
  const matches = h.savedConfig.teams.filter((e) => e.teamId === 'marketing' && e.projectId === 'p1');
  assert.equal(matches.length, 1, 'no duplicate activation for the same pair');
});

test('remove-team-instance drops the activation and broadcasts it', () => {
  const broadcasts = [];
  const h = harness({
    registry: realRegistry,
    getProjectPathById: () => 'C:/proj',
    broadcastControl: (m) => broadcasts.push(m),
  });
  h.send({ type: 'add-team-instance', teamId: 'marketing', projectId: 'p1' });
  h.send({ type: 'remove-team-instance', teamId: 'marketing', projectId: 'p1' });
  assert.equal(h.savedConfig.teams.filter((e) => e.projectId === 'p1').length, 0, 'activation removed');
  assert.ok(broadcasts.some((m) => m.type === 'team-instance-removed'));
});

test('open-artifact opens a known file and rejects unknown files + path traversal', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-art-'));
  const runDir = path.join(proj, '.glissa', 'teams', 'marketing', 'runs', '2026-06-02-tuesday');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'review.md'), 'VERDICT: SHIP\n', 'utf8');
  const opened = [];
  try {
    const h = harness({
      registry: realRegistry,
      getProjectPathById: () => proj,
      openInEditor: (p) => { opened.push(p); return { ok: true }; },
    });
    h.send({ type: 'open-artifact', teamId: 'marketing', projectId: 'p1', runId: '2026-06-02-tuesday', artifact: 'review.md' });
    assert.equal(opened.length, 1, 'opened the valid artifact');
    assert.ok(opened[0].endsWith('review.md'));
    assert.ok(h.sent.some((m) => m.type === 'artifact-opened' && m.ok === true));

    // Not one of the team's produced files.
    h.send({ type: 'open-artifact', teamId: 'marketing', projectId: 'p1', runId: '2026-06-02-tuesday', artifact: 'secrets.txt' });
    assert.ok(h.sent.some((m) => m.type === 'error' && /artifact/i.test(m.message)));

    // runId with a path separator is rejected by the segment guard.
    h.send({ type: 'open-artifact', teamId: 'marketing', projectId: 'p1', runId: 'a/b', artifact: 'review.md' });
    assert.ok(h.sent.some((m) => m.type === 'error' && /run id/i.test(m.message)));

    assert.equal(opened.length, 1, 'no editor spawn for rejected requests');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('get-team-pack-status reports configured + unfilled from the pack', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-'));
  try {
    const h = harness({
      registry: realRegistry,
      getProjectPathById: () => proj,
      teamOutput: {
        packStatus: () => ({
          configured: false,
          unfilled: ['voice-guide.md'],
          packDir: path.join(proj, '.glissa', 'teams', 'marketing', 'pack'),
        }),
      },
    });
    h.send({ type: 'get-team-pack-status', teamId: 'marketing', projectId: 'p1', requestId: 'ps1' });
    const msg = h.sent.find((m) => m.type === 'team-pack-status');
    assert.equal(msg.requestId, 'ps1');
    assert.equal(msg.configured, false);
    assert.deepEqual(msg.unfilled, ['voice-guide.md']);
    assert.ok(msg.packDir.endsWith('pack'));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('setup-team-pack starts the guided interview and acks with the session id', () => {
  const calls = [];
  const h = harness({
    startPackSetup: (args) => { calls.push(args); return { ok: true, sessionId: 'setup:marketing:p1' }; },
  });
  h.send({ type: 'setup-team-pack', teamId: 'marketing', projectId: 'p1' });
  assert.equal(calls.length, 1, 'delegated to startPackSetup');
  assert.deepEqual(calls[0], { teamId: 'marketing', projectId: 'p1' });
  const ack = h.sent.find((m) => m.type === 'setup-team-pack-started');
  assert.ok(ack, 'acked the start');
  assert.equal(ack.sessionId, 'setup:marketing:p1');
  assert.equal(ack.already, false);
});

test('setup-team-pack surfaces an already-running interview', () => {
  const h = harness({ startPackSetup: () => ({ ok: true, already: true, sessionId: 'setup:marketing:p1' }) });
  h.send({ type: 'setup-team-pack', teamId: 'marketing', projectId: 'p1' });
  const ack = h.sent.find((m) => m.type === 'setup-team-pack-started');
  assert.equal(ack.already, true);
});

test('setup-team-pack reports the backend error when it cannot start', () => {
  const h = harness({ startPackSetup: () => ({ ok: false, error: 'Unknown project' }) });
  h.send({ type: 'setup-team-pack', teamId: 'marketing', projectId: 'nope' });
  assert.ok(h.sent.some((m) => m.type === 'error' && /unknown project/i.test(m.message)));
});

test('setup-team-pack reports "not available" when no setup hook is wired', () => {
  const h = harness({}); // no startPackSetup
  h.send({ type: 'setup-team-pack', teamId: 'marketing', projectId: 'p1' });
  assert.ok(h.sent.some((m) => m.type === 'error' && /not available/i.test(m.message)));
});

test('setup-team-pack requires teamId and projectId', () => {
  const h = harness({ startPackSetup: () => assert.fail('should not be called') });
  h.send({ type: 'setup-team-pack', teamId: 'marketing' });
  assert.ok(h.sent.some((m) => m.type === 'error' && /required/i.test(m.message)));
});
