'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSetupGuide, commandLine, recipeIds, relayInvocation } = require('../server/core/editor-setup-core');

const ON_PATH = relayInvocation({ glissaOnPath: true });
const OFF_PATH = relayInvocation({ glissaOnPath: false, cliPath: '/opt/glissa/bin/glissa.js', nodePath: '/usr/bin/node' });

test('the invocation prefers the CLI on PATH and falls back to node plus the entry point', () => {
  assert.equal(commandLine(ON_PATH), 'glissa visions relay');
  assert.equal(commandLine(OFF_PATH), '/usr/bin/node /opt/glissa/bin/glissa.js visions relay');
});

test('every recipe carries the resolved invocation, whichever form it took', () => {
  for (const invocation of [ON_PATH, OFF_PATH]) {
    const { sections } = buildSetupGuide({ invocation });
    assert.equal(sections.length, recipeIds().length);
    for (const section of sections) {
      if (section.id === 'vscode') continue;
      for (const part of [invocation.command, ...invocation.args]) {
        assert.ok(section.snippet.includes(part), `${section.id} snippet is missing ${part}`);
      }
    }
  }
});

test('every editor recipe targets markdown, since that is all the lane sweeps', () => {
  const { sections } = buildSetupGuide({ invocation: ON_PATH });
  for (const section of sections) {
    if (section.id === 'vscode' || section.id === 'jetbrains') continue;
    assert.match(section.snippet, /[Mm]arkdown/, `${section.id} snippet does not name markdown`);
  }
});

test('one editor can be asked for by id, and an unknown one refuses', () => {
  const helix = buildSetupGuide({ editorId: 'helix', invocation: ON_PATH });
  assert.deepEqual(helix.sections.map((section) => section.id), ['helix']);
  assert.match(helix.sections[0].snippet, /\[language-server\.glissa-visions\]/);

  const unknown = buildSetupGuide({ editorId: 'notepad', invocation: ON_PATH });
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.sections, []);
});

test('the json snippets are valid json, so a paste cannot break the editor config', () => {
  const { sections } = buildSetupGuide({ invocation: ON_PATH });
  for (const id of ['sublime', 'kate']) {
    const section = sections.find((entry) => entry.id === id);
    assert.doesNotThrow(() => JSON.parse(section.snippet), `${id} snippet is not valid json`);
  }
});
