'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideEditorTargets, isExtensionInstalled, parseInstalledExtensions, visionsExtensionFiles,
} = require('../server/core/editor-extension-core');

test('every detected editor is a target, in candidate order', () => {
  const { targets, reason } = decideEditorTargets({
    resolvedByCommand: { cursor: '/usr/bin/cursor', codium: '/usr/bin/codium' },
  });
  assert.equal(reason, 'detected');
  assert.deepEqual(targets.map((target) => target.command), ['codium', 'cursor']);
  assert.equal(targets[0].commandPath, '/usr/bin/codium');
});

test('an explicit editor wins and unresolved means no targets at all', () => {
  const chosen = decideEditorTargets({ requested: 'code', resolvedByCommand: { code: '/usr/bin/code', codium: '/usr/bin/codium' } });
  assert.deepEqual(chosen.targets.map((target) => target.command), ['code']);

  const missing = decideEditorTargets({ requested: 'code', resolvedByCommand: { codium: '/usr/bin/codium' } });
  assert.deepEqual(missing.targets, []);
  assert.match(missing.reason, /not found on PATH: code/);
});

test('no editor on PATH refuses rather than picking one', () => {
  const { targets, reason } = decideEditorTargets({ resolvedByCommand: {} });
  assert.deepEqual(targets, []);
  assert.match(reason, /no VS Code family editor/);
});

test('an unknown requested editor still installs under its own command name', () => {
  const { targets } = decideEditorTargets({ requested: 'positron', resolvedByCommand: { positron: '/opt/positron' } });
  assert.deepEqual(targets, [{ command: 'positron', label: 'positron', commandPath: '/opt/positron' }]);
});

test('the packed extension stamps the relay path it was built from', () => {
  const files = visionsExtensionFiles({
    manifestJson: '{}', extensionJs: 'a', convertJs: 'b', lspCoreJs: 'c', relayPath: '/opt/glissa/session/visions-relay.js',
  });
  assert.deepEqual(files.map((file) => file.path), ['package.json', 'extension.js', 'lsp-convert.js', 'visions-lsp-core.js', 'relay-path.json']);
  assert.equal(JSON.parse(files[4].data).relayPath, '/opt/glissa/session/visions-relay.js');
});

test('installed detection ignores case and blank lines', () => {
  const stdout = '\nms-python.python\nJohnWaters.Glissa-Visions\n\n';
  assert.deepEqual(parseInstalledExtensions(stdout), ['ms-python.python', 'JohnWaters.Glissa-Visions']);
  assert.equal(isExtensionInstalled(stdout, 'johnwaters.glissa-visions'), true);
  assert.equal(isExtensionInstalled(stdout, 'johnwaters.other'), false);
});
