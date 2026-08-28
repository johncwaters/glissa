'use strict';

/*
 * The write boundary an ephemeral lane hands its headless session. Every expectation here was settled
 * by live probes against the real CLI (2.1.250), reading the machine-readable tool_result of a
 * stream-json run rather than the model's narration, because four plausible spellings fail silently.
 * The counter-examples are the point of this file: each `notEqual` below is a rule shape that LOOKS
 * like a boundary and is not one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ACCEPT_EDITS_MODE, buildLanePermissions } = require('../server/core/lane-permissions-core');
const { buildHookSettings } = require('../detection/settings-injector');
const { MEMORY_DISTILL_DENY_TOOLS, makeMemoryDistillWorkDir } = require('../server/memory-distill');
const { makePackDistillResultFile } = require('../server/pack-distiller');
const { VISIONS_DENY_TOOLS, makeVisionsWorkDir } = require('../server/visions-dispatch');

test('the boundary is acceptEdits over the throwaway cwd, and there is no allow list at all', () => {
  const posture = buildLanePermissions({ denyTools: ['Bash'] });
  assert.equal(posture.permissions.defaultMode, ACCEPT_EDITS_MODE);
  assert.deepEqual(posture.permissions.deny, ['Bash']);
  // A bare `Write` allow is exactly what unbounds the writes; nothing narrower grants the tool.
  assert.equal(Object.hasOwn(posture.permissions, 'allow'), false);
});

test('the mode is set by the lane, not inherited: an operator running auto has a classifier deciding', () => {
  for (const denyTools of [MEMORY_DISTILL_DENY_TOOLS, VISIONS_DENY_TOOLS]) {
    assert.equal(buildLanePermissions({ denyTools }).permissions.defaultMode, 'acceptEdits');
  }
});

test('no lane denies a bare Read, Write, Glob or Grep: a bare Read deny refuses the Write tool', () => {
  for (const denyTools of [MEMORY_DISTILL_DENY_TOOLS, VISIONS_DENY_TOOLS]) {
    for (const tool of ['Read', 'Write', 'Glob', 'Grep']) {
      assert.equal(denyTools.includes(tool), false, `${tool} in ${denyTools.join(',')}`);
    }
  }
});

test('no lane leans on a path deny: probed, it does not refuse a Write tool call', () => {
  for (const denyTools of [MEMORY_DISTILL_DENY_TOOLS, VISIONS_DENY_TOOLS]) {
    for (const rule of denyTools) {
      assert.equal(
        /^(Edit|Write)\(/.test(rule), false,
        `${rule} reads as a write boundary and is not one; the cwd plus acceptEdits is the boundary`
      );
    }
  }
});

test('the managed settings file carries the mode, or the boundary never reaches the session', () => {
  const posture = buildLanePermissions({ denyTools: ['Bash'] });
  const settings = buildHookSettings({
    port: 3000, glissaId: 'sess-1', token: 't', permissions: posture.permissions,
  });
  assert.deepEqual(settings.permissions, { deny: ['Bash'], defaultMode: 'acceptEdits' });
});

test('a lane passing neither deny nor mode leaves an ordinary session byte-identical', () => {
  const bare = buildHookSettings({ port: 3000, glissaId: 'sess-1', token: 't' });
  assert.equal(Object.hasOwn(bare, 'permissions'), false);
  const denyOnly = buildHookSettings({
    port: 3000, glissaId: 'sess-1', token: 't', permissions: { deny: ['Bash(gh:*)'] },
  });
  assert.deepEqual(denyOnly.permissions, { deny: ['Bash(gh:*)'] }, 'the deny-only lanes are unchanged');
});

// Probed against 2.1.250 in a throwaway cwd by counting what the transcript actually loaded, not by
// reading the help: without these a visions dispatch carried 66 MCP tools, 44 skills and three of the
// operator's own SessionStart hooks into a lane whose whole posture is "least capability that writes
// one result file".
test('a lane on this seam is told what NOT to load, since a settings file cannot say it', () => {
  const { args } = buildLanePermissions();
  assert.deepEqual(args, ['--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project,local']);
  assert.ok(args.includes('--strict-mcp-config'), 'no --mcp-config beside it means zero MCP servers, so no lane can reach Gmail or Slack');
  assert.equal(args.includes('user'), false, "the operator's own hooks and output style are not this lane's");
});

test('--tools is never the last token, since only a following option ends the variadic flag', () => {
  const { args } = buildLanePermissions({ allowTools: ['Read', 'Write'] });
  assert.deepEqual(args.slice(0, 2), ['--tools', 'Read,Write'], 'emitted ahead of the environment flags, which always follow it');
  assert.notEqual(args.at(-1), 'Read,Write', 'a trailing --tools value eats the positional prompt: "Input must be provided"');
  assert.ok(args.at(-2).startsWith('--'), 'whatever ends the argv, the variadic is already bounded by an option');
  // The comma-join is how the flag takes a list; it is NOT what bounds it (probed on 2.1.250).
  assert.equal(args.filter((arg) => arg === 'Read' || arg === 'Write').length, 0);
});

/*
 * The seam is the three lanes that spawn in an empty mkdtemp cwd. pr-review and posthog are outside it
 * on purpose: they cwd into a real repository worktree and need Bash and gh, so they keep the
 * operator's environment. Enumerated here so the split is a decision on the record rather than a gap
 * the next lane author inherits by copying pr-review.
 */
test('the lanes outside the seam are named, and the ones on it all cwd into a throwaway dir', async () => {
  const readSource = (file) => fs.readFileSync(path.join(__dirname, '..', 'server', file), 'utf8');
  const LANES_ON_THE_SEAM = ['visions-dispatch.js', 'memory-distill.js', 'pack-distiller.js'];
  const LANES_OFF_THE_SEAM = ['pr-review-wiring.js', 'posthog-wiring.js'];
  const packResultFile = await makePackDistillResultFile('lane-permissions', 0);
  // The cwd each lane hands its session, not a name in its source: a settings dir satisfies a substring.
  const LANE_WORK_DIRS = [
    { file: 'visions-dispatch.js', dir: await makeVisionsWorkDir(), cleanup: (dir) => fs.rmSync(dir, { recursive: true, force: true }) },
    { file: 'memory-distill.js', dir: await makeMemoryDistillWorkDir(), cleanup: (dir) => fs.rmSync(dir, { recursive: true, force: true }) },
    { file: 'pack-distiller.js', dir: path.dirname(packResultFile.path), cleanup: () => packResultFile.cleanup() },
  ];
  const realTmp = fs.realpathSync(os.tmpdir());

  for (const file of LANES_ON_THE_SEAM) {
    assert.ok(readSource(file).includes('buildLanePermissions'), `${file} builds its posture here`);
  }
  for (const { file, dir, cleanup } of LANE_WORK_DIRS) {
    try {
      const resolved = fs.realpathSync(dir);
      assert.equal(
        resolved.startsWith(realTmp + path.sep), true,
        `${file} must cwd into a temp dir, or --setting-sources project,local loads a real repo's settings and hooks`,
      );
      assert.deepEqual(fs.readdirSync(dir), [], `${file} must cwd into an EMPTY dir it owns`);
    } finally {
      await cleanup(dir);
    }
  }
  for (const file of LANES_OFF_THE_SEAM) {
    assert.equal(
      readSource(file).includes('buildLanePermissions'), false,
      `${file} runs cwd'd in a real worktree and needs Bash and gh, so it keeps the operator's environment; wiring it here means updating this list and its reason`,
    );
  }
});

test('an allow-list never replaces the deny list, and never becomes a bare Write allow', () => {
  const { permissions, args } = buildLanePermissions({ denyTools: ['Bash'], allowTools: ['Read', 'Write'] });
  assert.deepEqual(permissions.deny, ['Bash']);
  assert.equal(Object.hasOwn(permissions, 'allow'), false);
  assert.equal(permissions.defaultMode, ACCEPT_EDITS_MODE);
  assert.ok(args.includes('--tools'));
});
