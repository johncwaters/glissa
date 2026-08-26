// Every editor talks to the SAME stdio relay; invocation resolves live so a moved install never bakes a dead path.

'use strict';

function relayInvocation({ glissaOnPath = true, cliPath = '', nodePath = 'node' } = {}) {
  if (glissaOnPath) return { command: 'glissa', args: ['visions', 'relay'] };
  return { command: nodePath, args: [cliPath, 'visions', 'relay'] };
}

function invocationParts(invocation) {
  return [invocation.command, ...invocation.args];
}

function commandLine(invocation) {
  return invocationParts(invocation).join(' ');
}

function jsonCommandArray(invocation) {
  return JSON.stringify(invocationParts(invocation));
}

function neovimSnippet(invocation) {
  return [
    "vim.api.nvim_create_autocmd('FileType', {",
    "  pattern = 'markdown',",
    '  callback = function()',
    "    vim.lsp.start({ name = 'glissa-visions', cmd = { " + invocationParts(invocation).map((part) => `'${part}'`).join(', ') + ' } })',
    '  end,',
    '})',
  ].join('\n');
}

function helixSnippet(invocation) {
  return [
    '[language-server.glissa-visions]',
    `command = "${invocation.command}"`,
    `args = ${JSON.stringify(invocation.args)}`,
    '',
    '[[language]]',
    'name = "markdown"',
    'language-servers = ["marksman", "glissa-visions"]',
  ].join('\n');
}

function emacsSnippet(invocation) {
  return [
    "(with-eval-after-load 'eglot",
    '  (add-to-list \'eglot-server-programs',
    `               '(markdown-mode . (${invocationParts(invocation).map((part) => `"${part}"`).join(' ')}))))`,
  ].join('\n');
}

function sublimeSnippet(invocation) {
  return [
    '{',
    '  "clients": {',
    '    "glissa-visions": {',
    '      "enabled": true,',
    `      "command": ${jsonCommandArray(invocation)},`,
    '      "selector": "text.html.markdown"',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

function kateSnippet(invocation) {
  return [
    '{',
    '  "servers": {',
    '    "markdown": {',
    `      "command": ${jsonCommandArray(invocation)},`,
    '      "highlightingModeRegex": "^Markdown$"',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

function genericSnippet(invocation) {
  return `command: ${commandLine(invocation)}\ntransport: stdio\nlanguages: markdown`;
}

const EDITOR_RECIPES = [
  {
    id: 'vscode',
    label: 'VS Code, VSCodium, Cursor, Windsurf',
    where: 'installed for you',
    build: () => 'glissa visions install',
  },
  {
    id: 'neovim',
    label: 'Neovim',
    where: 'init.lua (or any file it loads)',
    build: neovimSnippet,
  },
  {
    id: 'helix',
    label: 'Helix',
    where: '~/.config/helix/languages.toml',
    build: helixSnippet,
  },
  {
    id: 'emacs',
    label: 'Emacs (eglot)',
    where: 'init.el',
    build: emacsSnippet,
  },
  {
    id: 'sublime',
    label: 'Sublime Text (LSP package)',
    where: 'Preferences: LSP Settings',
    build: sublimeSnippet,
  },
  {
    id: 'kate',
    label: 'Kate',
    where: 'Settings > LSP Client > User Server Settings',
    build: kateSnippet,
  },
  {
    id: 'jetbrains',
    label: 'JetBrains IDEs (LSP4IJ plugin)',
    where: 'Settings > Language Servers > New > Command',
    build: commandLine,
  },
  {
    id: 'other',
    label: 'Any other LSP client',
    where: 'wherever it registers a language server',
    build: genericSnippet,
  },
];

function recipeIds() {
  return EDITOR_RECIPES.map((recipe) => recipe.id);
}

function buildSetupGuide({ editorId = null, invocation } = {}) {
  const recipes = editorId ? EDITOR_RECIPES.filter((recipe) => recipe.id === editorId) : EDITOR_RECIPES;
  if (recipes.length === 0) return { ok: false, reason: `unknown editor: ${editorId}`, sections: [] };
  return {
    ok: true,
    reason: 'ok',
    sections: recipes.map((recipe) => ({
      id: recipe.id,
      label: recipe.label,
      where: recipe.where,
      snippet: recipe.build(invocation),
    })),
  };
}

module.exports = {
  EDITOR_RECIPES,
  buildSetupGuide,
  commandLine,
  recipeIds,
  relayInvocation,
};
