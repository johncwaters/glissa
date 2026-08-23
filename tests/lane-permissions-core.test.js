'use strict';

/*
 * The write boundary an ephemeral lane hands its headless session. Every expectation here was settled
 * by live probes against the real CLI (2.1.241), reading the machine-readable tool_result of a
 * stream-json run rather than the model's narration, because four plausible spellings fail silently.
 * The counter-examples are the point of this file: each `notEqual` below is a rule shape that LOOKS
 * like a boundary and is not one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ACCEPT_EDITS_MODE, buildLanePermissions } = require('../server/core/lane-permissions-core');
const { buildHookSettings } = require('../detection/settings-injector');
const { MEMORY_DISTILL_DENY_TOOLS } = require('../server/memory-distill');
const { VISIONS_DENY_TOOLS } = require('../server/visions-dispatch');

test('the boundary is acceptEdits over the throwaway cwd, and there is no allow list at all', () => {
  const posture = buildLanePermissions({ denyTools: ['Bash'] });
  assert.equal(posture.permissions.defaultMode, ACCEPT_EDITS_MODE);
  assert.deepEqual(posture.permissions.deny, ['Bash']);
  // A bare `Write` allow is exactly what unbounds the writes; nothing narrower grants the tool.
  assert.equal(Object.hasOwn(posture.permissions, 'allow'), false);
  assert.equal(Object.hasOwn(posture, 'allowedToolsArg'), false);
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
