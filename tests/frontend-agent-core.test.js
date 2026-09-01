'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// agent-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/session-card/agent-core.ts');

test('agentBadgeText: the default agent renders no badge', async () => {
  const { agentBadgeText, DEFAULT_AGENT_ID } = await importCore();
  assert.equal(agentBadgeText(DEFAULT_AGENT_ID), '');
  assert.equal(agentBadgeText('claude-code'), '');
});

test('agentBadgeText: a mapped non-default agent renders its short label', async () => {
  const { agentBadgeText } = await importCore();
  assert.equal(agentBadgeText('codex'), 'Codex');
  assert.equal(agentBadgeText('grok'), 'Grok');
});

test('agentBadgeText: an unmapped id renders as-is rather than vanishing', async () => {
  const { agentBadgeText } = await importCore();
  assert.equal(agentBadgeText('future-agent'), 'future-agent');
  assert.equal(agentBadgeText('  codex  '), 'Codex');
});

test('agentBadgeText: non-string and empty inputs render nothing', async () => {
  const { agentBadgeText } = await importCore();
  assert.equal(agentBadgeText(null), '');
  assert.equal(agentBadgeText(undefined), '');
  assert.equal(agentBadgeText(''), '');
  assert.equal(agentBadgeText(42), '');
});

test('decideAgentPicker: a single resolvable agent hides the picker', async () => {
  const { decideAgentPicker } = await importCore();
  const out = decideAgentPicker([{ id: 'claude-code', label: 'Claude Code', resolvable: true }]);
  assert.equal(out.show, false);
  assert.equal(out.selectedId, 'claude-code');
  assert.deepEqual(out.options, [{ id: 'claude-code', label: 'Claude Code' }]);
});

test('decideAgentPicker: only resolvable agents are offered', async () => {
  const { decideAgentPicker } = await importCore();
  const out = decideAgentPicker([
    { id: 'claude-code', label: 'Claude Code', resolvable: true },
    { id: 'codex', label: 'Codex CLI', resolvable: false },
  ]);
  assert.equal(out.show, false);
  assert.deepEqual(out.options, [{ id: 'claude-code', label: 'Claude Code' }]);
});

test('decideAgentPicker: two resolvable agents show the picker, default selected', async () => {
  const { decideAgentPicker } = await importCore();
  const out = decideAgentPicker([
    { id: 'claude-code', label: 'Claude Code', resolvable: true },
    { id: 'codex', label: 'Codex CLI', resolvable: true },
  ]);
  assert.equal(out.show, true);
  assert.equal(out.selectedId, 'claude-code');
  assert.deepEqual(out.options.map((o) => o.id), ['claude-code', 'codex']);
});

test('decideAgentPicker: when the default does not resolve, the first resolvable is selected', async () => {
  const { decideAgentPicker } = await importCore();
  const out = decideAgentPicker([
    { id: 'codex', label: 'Codex CLI', resolvable: true },
    { id: 'grok', label: 'Grok CLI', resolvable: true },
  ]);
  assert.equal(out.show, true);
  assert.equal(out.selectedId, 'codex');
});

test('decideAgentPicker: an option missing a label falls back to its id', async () => {
  const { decideAgentPicker } = await importCore();
  const out = decideAgentPicker([
    { id: 'claude-code', label: 'Claude Code', resolvable: true },
    { id: 'codex', resolvable: true },
  ]);
  assert.deepEqual(out.options, [
    { id: 'claude-code', label: 'Claude Code' },
    { id: 'codex', label: 'codex' },
  ]);
});

test('decideAgentPicker: no resolvable agents hides the picker and keeps the default', async () => {
  const { decideAgentPicker, DEFAULT_AGENT_ID } = await importCore();
  const empty = decideAgentPicker([]);
  assert.equal(empty.show, false);
  assert.equal(empty.selectedId, DEFAULT_AGENT_ID);
  const nonResolvable = decideAgentPicker([{ id: 'codex', label: 'Codex CLI', resolvable: false }]);
  assert.equal(nonResolvable.show, false);
  assert.equal(nonResolvable.selectedId, DEFAULT_AGENT_ID);
});

test('decideAgentPicker: bad input never throws', async () => {
  const { decideAgentPicker, DEFAULT_AGENT_ID } = await importCore();
  assert.equal(decideAgentPicker(null).selectedId, DEFAULT_AGENT_ID);
  assert.equal(decideAgentPicker(undefined).show, false);
  assert.equal(decideAgentPicker([null, {}, { id: 'codex', resolvable: true }, { resolvable: true }]).selectedId, 'codex');
});
