'use strict';

// M1 of docs/plan-agent-adapters.md is a refactor with zero behavior change, so these are the pins
// that say so: the spawn argv and the injected settings file a claude-code session produces, the
// hook vocabulary the router now reads off the adapter, the laziness of the command registry that
// replaced the module-load CLAUDE_CMD global, and the config surface that selects an agent.
// The argv and settings expectations below were captured by running the PRE-extraction tree
// (git HEAD before the adapter commit) through the same Session options.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Session } = require('../session/sessions');
const { HookRouter } = require('../detection/hook-source');
const { writeSessionSettings } = require('../detection/settings-injector');
const claudeCode = require('../session/adapters/claude-code');
const adapters = require('../session/adapters');
const { validateConfig } = require('../server/config-store');

const REPO_ROOT = path.join(__dirname, '..');
const RESUME_ID = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';

function fakePty(pid = 2147483646) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

function tmpHooksDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-adapter-'));
}

test('the registry exposes claude-code as the default and refuses an unknown id', () => {
  assert.equal(adapters.DEFAULT_AGENT_ID, 'claude-code');
  assert.deepEqual(adapters.listAgentIds(), ['claude-code']);
  assert.equal(adapters.isKnownAgentId('claude-code'), true);
  assert.equal(adapters.isKnownAgentId('codex'), false);
  assert.equal(adapters.getAdapter('codex'), null);
  assert.equal(adapters.getAdapter(null), claudeCode);
});

test('an unknown agent id warns and falls back to the default rather than failing', () => {
  const warnings = [];
  const adapter = adapters.resolveAdapter('grok', { warn: (m) => warnings.push(m), label: 'session:x' });
  assert.equal(adapter, claudeCode);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown agent "grok"/);
});

test('claude-code declares every capability, since it is the reference implementation', () => {
  assert.deepEqual(Object.keys(claudeCode.capabilities).sort(), [
    'antiSlop', 'awaitingInput', 'backgroundAgents', 'compactQuiet', 'headless', 'hooks',
    'packNotice', 'packs', 'resume', 'rtk', 'skipPermissionsFlag', 'statusLine',
  ]);
  assert.equal(Object.values(claudeCode.capabilities).every((v) => v === true), true);
});

test('buildArgs keeps the pre-extraction order: perms, resume, lane flags, anti-slop, prompt last', () => {
  const args = claudeCode.buildArgs({
    dangerouslySkipPermissions: true,
    resumeSessionId: RESUME_ID,
    extraArgs: ['-p', '--model', 'sonnet'],
    antiSlopPrompt: true,
    initialPrompt: 'THE PROMPT',
  });
  assert.deepEqual(args.slice(0, 6), [
    '--dangerously-skip-permissions', '--resume', RESUME_ID, '-p', '--model', 'sonnet',
  ]);
  assert.equal(args[6], '--append-system-prompt');
  assert.equal(args[args.length - 1], 'THE PROMPT');
  assert.deepEqual(claudeCode.buildArgs(), [], 'a plain user session adds nothing');
});

test('spawn argv for a fully featured session is byte-identical to the pre-extraction one', async () => {
  const hooksBaseDir = tmpHooksDir();
  const calls = [];
  const session = new Session({
    id: 'capture-session',
    name: 'capture',
    path: process.cwd(),
    dangerouslySkipPermissions: true,
    resumeSessionId: RESUME_ID,
    extraClaudeArgs: ['-p', '--model', 'sonnet'],
    antiSlopPrompt: true,
    initialPrompt: 'THE PROMPT',
    hookRouter: new HookRouter(),
    getHookPort: () => 41234,
    hooksBaseDir,
    planLimits: true,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args, opts) => { calls.push({ file, args, env: opts.env }); return fakePty(); },
  });
  try {
    await session.start();
    const { args, env } = calls[0];
    const settingsPath = path.join(hooksBaseDir, 'capture-session', 'settings.json');
    assert.deepEqual(args.slice(0, 9), [
      '--settings', settingsPath,
      '--dangerously-skip-permissions',
      '--resume', RESUME_ID,
      '-p', '--model', 'sonnet',
      '--append-system-prompt',
    ]);
    assert.equal(args[args.length - 1], 'THE PROMPT');
    assert.equal(args.length, 11);
    assert.equal(env.CLAUDE_CODE_NO_FLICKER, '1');
    assert.equal('CLAUDECODE' in env, false);
    assert.equal('GLISSA_PORT' in env, false);
    assert.equal('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD' in env, false, 'no packs delivered');
  } finally {
    session.destroy();
    fs.rmSync(hooksBaseDir, { recursive: true, force: true });
  }
});

test('the settings file a session injects is byte-identical to the injector run with its options', async () => {
  const hooksBaseDir = tmpHooksDir();
  const expectedBaseDir = tmpHooksDir();
  const session = new Session({
    id: 'settings-session',
    name: 'settings',
    path: process.cwd(),
    hookRouter: new HookRouter(),
    getHookPort: () => 41234,
    hooksBaseDir,
    planLimits: true,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
  });
  try {
    await session.start();
    const written = fs.readFileSync(path.join(hooksBaseDir, 'settings-session', 'settings.json'), 'utf8');
    const token = written.match(/\?t=([a-f0-9]+)/)[1];
    const expected = writeSessionSettings({
      port: 41234,
      glissaId: 'settings-session',
      baseDir: expectedBaseDir,
      token,
      permissions: null,
      detectScheduledWakeups: true,
      packReadTelemetry: false,
      enableProjectMcp: false,
      rtkPath: null,
      planLimits: true,
    });
    assert.equal(written, fs.readFileSync(expected.settingsPath, 'utf8'));
    const parsed = JSON.parse(written);
    assert.deepEqual(Object.keys(parsed.hooks), [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest',
      'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'PostToolUse',
    ]);
  } finally {
    session.destroy();
    fs.rmSync(hooksBaseDir, { recursive: true, force: true });
    fs.rmSync(expectedBaseDir, { recursive: true, force: true });
  }
});

// The whole Claude Code hook vocabulary in one table, so a moved mapper cannot quietly drop a case.
const HOOK_CASES = [
  ['SessionStart', {}, 'session-start', null, null],
  ['SessionEnd', {}, 'session-end', null, null],
  ['UserPromptSubmit', {}, 'resume', null, null],
  ['Stop', {}, 'ready', null, null],
  ['SubagentStart', {}, 'subagent-start', null, null],
  ['SubagentStop', {}, 'subagent-stop', null, null],
  ['TaskCreated', {}, 'task-created', null, null],
  ['TaskCompleted', {}, 'task-completed', null, null],
  ['TeammateIdle', {}, 'teammate-idle', null, null],
  ['PermissionRequest', {}, 'awaiting-input', null, 'permission'],
  ['PostToolUse', { tool_name: 'ScheduleWakeup' }, 'wakeup-scheduled', null, null],
  ['PostToolUse', { tool_name: 'CronCreate' }, 'cron-created', null, null],
  ['PostToolUse', { tool_name: 'CronDelete' }, 'cron-deleted', null, null],
  ['PostToolUse', { tool_name: 'Read' }, 'pack-read', null, null],
  ['PostToolUse', { tool_name: 'Bash' }, null, null, null],
  ['Notification', { notification_type: 'idle_prompt' }, 'ready', 'low', null],
  ['Notification', { notification_type: 'permission_prompt' }, 'awaiting-input', null, 'permission'],
  ['Notification', { notification_type: 'elicitation_request' }, 'awaiting-input', null, 'elicitation'],
  ['Notification', { notification_type: 'auth_success' }, null, null, null],
  ['PreToolUse', {}, null, null, null],
];

test('the adapter hook table reproduces every pre-extraction mapping', () => {
  for (const [event, payload, signal, confidence, promptKind] of HOOK_CASES) {
    assert.equal(claudeCode.hooks.mapSignal(event, payload), signal, `${event} signal`);
    assert.equal(claudeCode.hooks.mapConfidence(event, payload), confidence, `${event} confidence`);
    if (signal === 'awaiting-input') {
      assert.equal(claudeCode.hooks.mapPromptKind(event, payload), promptKind, `${event} promptKind`);
    }
  }
});

test('HookRouter translates with the registered session adapter, defaulting to claude-code', () => {
  const router = new HookRouter();
  const seen = [];
  router.register('s1', { token: 'tok', onSignal: (s) => seen.push(s) });
  router.register('s2', { token: 'tok', onSignal: (s) => seen.push(s), hooks: claudeCode.hooks });
  for (const id of ['s1', 's2']) {
    const out = router.handle({ glissaId: id, event: 'Notification', token: 'tok', payload: { notification_type: 'idle_prompt' } });
    assert.equal(out.signal, 'ready');
  }
  assert.deepEqual(seen.map((s) => [s.signal, s.confidence]), [['ready', 'low'], ['ready', 'low']]);
});

test('the title source classifies with the adapter profile', () => {
  assert.equal(claudeCode.titleProfile.isSpinnerChar('⠁'), true, 'braille frame');
  assert.equal(claudeCode.titleProfile.isSpinnerChar('◐'), true, 'circle-halves frame');
  assert.equal(claudeCode.titleProfile.isIdleChar('✳'), true);
  assert.equal(claudeCode.titleProfile.isIdleChar('⠁'), false);
  assert.equal(claudeCode.titleProfile.dropsLeadingAscii, true);
});

test('requiring sessions.js resolves no agent binary; the first use does, and caches it', () => {
  const { execFileSync } = require('node:child_process');
  const probe = `
    const cps = require('./server/child-process-safe');
    const real = cps.execSync;
    const seen = [];
    cps.execSync = (cmd, opts) => { seen.push(String(cmd)); return real(cmd, opts); };
    const claudeLookups = () => seen.filter((c) => /claude/.test(c)).length;
    const sessions = require('./session/sessions');
    const afterRequire = claudeLookups();
    sessions.CLAUDE_CMD;
    const afterFirstUse = claudeLookups();
    sessions.CLAUDE_CMD;
    const afterSecondUse = claudeLookups();
    process.stdout.write('RESULT' + JSON.stringify({ afterRequire, afterFirstUse, afterSecondUse }));
  `;
  const out = execFileSync(process.execPath, ['-e', probe], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const counts = JSON.parse(out.slice(out.indexOf('RESULT') + 'RESULT'.length));
  assert.equal(counts.afterRequire, 0, 'requiring sessions.js must not pay a PATH lookup');
  assert.ok(counts.afterFirstUse > 0, 'the first use resolves');
  assert.equal(counts.afterSecondUse, counts.afterFirstUse, 'and the registry caches it');
});

test('the command registry resolves once per agent id and re-resolves after a reset', () => {
  adapters.resetCommandCache();
  try {
    let resolutions = 0;
    const exec = () => { resolutions += 1; return '/usr/local/bin/claude\n'; };
    const first = adapters.commandFor('claude-code', { platform: 'linux', exec });
    const second = adapters.commandFor('claude-code', { platform: 'linux', exec });
    assert.equal(resolutions, 1);
    assert.equal(second, first);
    assert.deepEqual(first, { path: '/usr/local/bin/claude', kind: 'shim' });
    adapters.resetCommandCache();
    adapters.commandFor('claude-code', { platform: 'linux', exec });
    assert.equal(resolutions, 2);
  } finally {
    adapters.resetCommandCache();
  }
});

test('config accepts an absent or claude-code agent on a project and refuses anything else', () => {
  assert.equal(validateConfig({ projects: [{ path: '/a' }] }).ok, true);
  assert.equal(validateConfig({ projects: [{ path: '/a', agent: 'claude-code' }] }).ok, true);
  const bad = validateConfig({ projects: [{ path: '/a', agent: 'codex' }] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, ['projects[0].agent must be one of: claude-code']);
  const wrongType = validateConfig({ projects: [{ path: '/a', agent: 7 }] });
  assert.equal(wrongType.ok, false);
});
