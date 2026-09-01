'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { ClientMessage, ServerMessage } = require('../shared/contracts/index.ts');
const { STATES } = require('../shared/states.ts');
const { registerControlHandlers } = require('../server/control-handlers');

function dispatchTypes(file, startMarker, endMarker) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return [...source.slice(start, end).matchAll(/^\s*['"]([a-z][a-z0-9-]*)['"]\s*:/gm)].map((match) => match[1]);
}

function schemaTypes(schema) {
  return new Set(schema.options.map((option) => option.shape.type.value));
}

test('control dispatch tables contain only contract message types', () => {
  const clientTypes = dispatchTypes('server/control-handlers.js', 'const handlers = {', "controlWss.on('connection'");
  const serverTypes = dispatchTypes('public/app.js', 'const messageHandlers = {', 'onControlMessage((msg)');
  const clientSchemaTypes = schemaTypes(ClientMessage);
  const serverSchemaTypes = schemaTypes(ServerMessage);
  assert.deepEqual(clientTypes.filter((type) => !clientSchemaTypes.has(type)), []);
  assert.deepEqual(serverTypes.filter((type) => !serverSchemaTypes.has(type)), []);
});

const NOW = 1_777_000_000_000;
const SESSION = {
  id: 'session-1',
  name: 'glissa',
  path: '/repo/glissa',
  agent: 'claude-code',
  state: STATES.RUNNING,
  stateSince: NOW,
  sleeping: false,
  dangerouslySkipPermissions: true,
  ephemeral: false,
  isWorktree: true,
  resumeSessionId: null,
  activeAgents: 0,
  packs: [{ name: 'rules', version: 'abc123' }],
  pendingWakeup: null,
  pendingPromptKind: null,
  mergeStatus: 'none',
  mergeReason: null,
  worktreeNotice: null,
  effectiveBase: 'develop',
  auditLog: [],
};

const REAL_SERVER_PAYLOADS = [
  { type: 'snapshot', sessions: [SESSION], packVersions: { rules: 'abc123' }, serverBuild: 'build-1' },
  { type: 'pack-updated', name: 'rules', version: 'def456' },
  { type: 'mill-report', requestId: 'mill-1', ts: NOW, autoRebuild: true, distillerEnabled: false, watcherCount: 2, projects: [], maxPacksPerProject: 4, packs: [], configWarnings: [], totals: {}, error: null },
  { type: 'project-packs-updated', projectId: 'project-1', packs: ['rules'] },
  { type: 'set-project-packs-result', requestId: 'packs-1', ok: true, error: null, projectId: 'project-1', pack: 'rules', deliver: true, packs: ['rules'] },
  { type: 'session-packs', id: 'session-1', packs: [{ name: 'rules', version: 'abc123' }] },
  { type: 'state-change', id: 'session-1', session: 'glissa', from: STATES.IDLE, to: STATES.RUNNING, event: 'user_input', timestamp: NOW },
  { type: 'session-added', id: 'session-1', session: 'glissa', path: '/repo/glissa', state: STATES.DORMANT, stateSince: NOW, skipPerms: true, worktree: false, resumeSessionId: null },
  { type: 'session-removed', id: 'session-1', session: 'glissa' },
  { type: 'session-renamed', id: 'session-1', oldName: 'old', newName: 'glissa' },
  { type: 'session-modified', id: 'session-1', session: 'glissa', path: '/repo/glissa', state: STATES.DORMANT, stateSince: NOW, skipPerms: true, worktree: false, resumeSessionId: null },
  { type: 'session-git', id: 'session-1', worktree: true },
  { type: 'session-resume', id: 'session-1', resumeSessionId: null },
  { type: 'session-agents', id: 'session-1', activeAgents: 2, session: 'glissa', timestamp: NOW },
  { type: 'session-wakeup', id: 'session-1', pendingWakeup: { at: NOW, kind: 'cron', reason: null }, session: 'glissa', timestamp: NOW },
  { type: 'session-prompt', id: 'session-1', pendingPromptKind: 'permission', session: 'glissa', timestamp: NOW },
  { type: 'session-sleep', id: 'session-1', session: 'glissa', timestamp: NOW },
  { type: 'session-wake', id: 'session-1', session: 'glissa', timestamp: NOW },
  { type: 'session-merge-status', id: 'session-1', session: 'glissa', mergeStatus: 'pending-review', reason: null, parked: false, timestamp: NOW },
  { type: 'session-worktree-blocked', id: 'session-1', session: 'glissa', branch: 'develop', notice: 'missing branch', timestamp: NOW },
  { type: 'session-worktree-ready', id: 'session-1', session: 'glissa', branch: 'glissa/session/1', base: 'develop', timestamp: NOW },
  { type: 'session-diff', id: 'session-1', committed: { stat: '1 file', diff: 'patch' }, uncommitted: { stat: '', diff: '' }, hasCommits: true },
  { type: 'branch-sync-status', id: 'session-1', branch: 'develop', upstream: 'origin/develop', state: 'ahead', ahead: 1, behind: 0, fetched: true },
  { type: 'session-changed', id: 'session-1', sig: 'sha' },
  { type: 'post-turn-result', id: 'session-1', session: 'glissa', mode: 'fix', skipped: null, filesFixed: 1, findings: [{ file: 'a.js', rule: 'finalNewline', count: 1 }], timestamp: NOW },
  { type: 'debug-state-response', id: 'session-1', payload: { state: STATES.RUNNING } },
  { type: 'notify', session: 'session-1', category: 'complete', message: 'finished', escalationCount: 0 },
  { type: 'update-available', updateAvailable: true, current: '0.23.1', latest: '0.24.0', currentSha: null, latestSha: '0123456789abcdef0123456789abcdef01234567', releaseUrl: 'https://example.test/release', command: 'npm install', flavor: 'npm-global' },
  { type: 'error', message: 'refused' },
  { type: 'session-error', id: 'session-1', session: 'glissa', message: 'failed' },
  { type: 'settings', requestId: 'settings-1', settings: { cursorBlink: false } },
  { type: 'settings-error', requestId: 'settings-1', message: 'invalid' },
  { type: 'settings-updated', requestId: 'settings-1', settings: { cursorBlink: true } },
  { type: 'pong', requestId: 'ping-1' },
  { type: 'agents-listed', requestId: 'agents-1', agents: [{ id: 'claude-code', label: 'Claude Code', resolvable: true }] },
  { type: 'repo-roots-scanned', requestId: 'roots-1', directories: [{ root: '/repo', projects: [{ name: 'glissa', path: '/repo/glissa' }] }] },
  { type: 'conversations', requestId: 'conversations-1', id: 'session-1', current: null, conversations: [{
    id: 'conversation-1',
    title: 'Fix contracts',
    cwd: '/repo/glissa',
    worktreePath: '/repo/glissa',
    worktreeName: 'glissa',
    gitBranch: 'refs/heads/feat/typed-contracts',
    mtime: NOW,
  }] },
  { type: 'resume-conversation-ack', id: 'session-1', resumeSessionId: 'conversation-1', ok: true },
  { type: 'health-snapshot', stats: { process: {}, sessions: {}, websockets: {} } },
  { type: 'posthog-status', ts: NOW, intervalMinutes: 15, projects: [], investigations: [] },
  { type: 'posthog-report', requestId: 'posthog-1', ok: true, found: true, issueId: 'issue-1', format: 'markdown', content: 'report' },
  { type: 'posthog-open-session-result', requestId: 'posthog-2', ok: true, error: null, sessionId: 'session-1' },
  { type: 'posthog-issue-action-result', requestId: 'posthog-3', ok: true, error: null, status: 'resolved' },
  { type: 'posthog-archive-investigation-result', requestId: 'posthog-4', ok: true, error: null },
  { type: 'pr-status', ts: NOW, projects: [] },
  { type: 'branch-gc-status', ts: NOW, projects: [] },
  { type: 'usage-sessions', ts: NOW, pricingSource: 'bundled', sessions: [{ id: 'session-1', tokens: 123, costUSD: 0.5, officialCostUSD: null }] },
  { type: 'usage-report', requestId: 'usage-1', ts: NOW, tz: 'UTC', blockHours: 5, totals: {}, daily: [], models: [], sessions: [], blocks: [], activeBlock: null, anomaly: null, byLane: {}, budget: {}, savings: {}, tokenLimit: null, pricing: {}, scan: {}, warning: null, error: null },
  { type: 'plan-limits', ts: NOW, fiveHour: { pct: 10, resetsAtMs: NOW + 1000 }, sevenDay: null, source: 'statusline' },
  { type: 'usage-budget-alert', scope: 'daily', periodKey: '2026-08-26', threshold: 50, spentUsd: 5, budgetUsd: 10, text: 'budget crossed', ts: NOW },
  { type: 'visions-findings', uri: 'file:///repo/a.js', diagnostics: [], ts: NOW },
  { type: 'visions-comments', uri: 'file:///repo/a.js', comments: [], ts: NOW },
  { type: 'visions-hand', uri: 'file:///repo/a.js', hand: null, ts: NOW },
  { type: 'visions-intent', projectId: null, intent: { text: 'intent', source: 'model', ts: NOW }, ts: NOW },
  { type: 'visions-fix', uri: 'file:///repo/a.js', fix: { code: 'x', line: 1, message: 'fixed', applied: true }, ts: NOW },
  { type: 'visions-snapshot', documents: [], intent: { global: null, byProject: {} }, fixes: [], ts: NOW },
  { type: 'ingest-activity', events: [], overflow: 0, ts: NOW },
  { type: 'ingest-snapshot', events: [], sources: { terminal: true }, ts: NOW },
  { type: 'client-trust', trust: 'local' },
  { type: 'sessions-reordered', order: ['session-1'] },
  { type: 'session-worktree-warning', id: 'session-1', session: 'Session 1', branch: 'glissa/session/session-1', notice: 'offline', timestamp: NOW },
  { type: 'shutting-down' },
  { type: 'restarting' },
  {
    type: 'hooks-report', requestId: 'r1', ts: NOW,
    hooks: [{ id: 'h1', name: 'lint', event: 'PostToolUse', matcher: 'Edit', type: 'command', command: 'npm run lint', enabled: true }],
    builtin: [{ event: 'Stop', matcher: null, purpose: 'Status detection' }],
    events: [{ name: 'PostToolUse', matcher: 'tool name (regex)', description: 'After a tool succeeds.' }],
    projects: [{ id: 'p1', name: 'glissa', agent: 'claude-code' }],
    limits: { maxTimeoutSec: 600 },
    error: null,
  },
  { type: 'save-hook-result', requestId: 'r2', ok: true, error: null, hook: { id: 'h1' } },
  { type: 'delete-hook-result', requestId: 'r3', ok: false, error: 'Unknown hook' },
  { type: 'hooks-updated', count: 1 },
];

test('real server payloads round-trip through every server contract variant', () => {
  assert.deepEqual(new Set(REAL_SERVER_PAYLOADS.map((payload) => payload.type)), schemaTypes(ServerMessage));
  for (const payload of REAL_SERVER_PAYLOADS) {
    const parsed = ServerMessage.safeParse(payload);
    assert.equal(parsed.success, true, `${payload.type}: ${parsed.error?.issues[0]?.message || 'invalid'}`);
    assert.deepEqual(parsed.data, payload, payload.type);
  }
});

test('session-diff pins the object payload returned by Session.getDiff', () => {
  const invalid = ServerMessage.safeParse({
    type: 'session-diff',
    id: 'session-1',
    committed: 'patch',
    uncommitted: 'patch',
    hasCommits: true,
  });
  assert.equal(invalid.success, false);
});

test('server variants read by the browser validate more than their type name', () => {
  const intentionallyOpaque = new Set(['session-sleep', 'session-wake', 'branch-gc-status', 'shutting-down', 'restarting']);
  for (const option of ServerMessage.options) {
    const type = option.shape.type.value;
    if (intentionallyOpaque.has(type)) continue;
    assert.ok(Object.keys(option.shape).length > 1, type);
  }
});

test('id-only client variants reject the removed session-name fallback', () => {
  assert.equal(ClientMessage.safeParse({ type: 'kill', session: 'glissa' }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'kill', id: 'session-1' }).success, true);
});

test('a malformed request receives its typed error reply with the Zod message', () => {
  const controlWss = new EventEmitter();
  const sent = [];
  let receive = null;
  const ws = {
    send: (payload) => sent.push(JSON.parse(payload)),
    on: (event, handler) => { if (event === 'message') receive = handler; },
  };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [] },
    configStore: { getSettings: () => ({}) },
    broadcastControl: () => {},
  });
  controlWss.emit('connection', ws);
  sent.length = 0;
  receive(JSON.stringify({
    type: 'set-project-packs',
    requestId: 'packs-1',
    projectId: 'project-1',
    pack: 'rules',
    deliver: 'yes',
  }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'set-project-packs-result');
  assert.equal(sent[0].ok, false);
  assert.match(sent[0].error, /boolean/);
  assert.equal(ServerMessage.safeParse(sent[0]).success, true);
});
