// Automatic editor wiring, one rule: a file we own is written whole, and a file the operator maintains
// is edited only inside a marked block or by the single key that names our server.

'use strict';

const MARKER_NAME = 'glissa-visions';
const SERVER_ID = 'glissa-visions';
const HELIX_BEGIN = `# >>> ${MARKER_NAME}`;
const HELIX_END = `# <<< ${MARKER_NAME}`;
const EMACS_BEGIN = `;; >>> ${MARKER_NAME}`;
const EMACS_END = `;; <<< ${MARKER_NAME}`;
const UNCHANGED = 'unchanged';

function parts(invocation) {
  return [invocation.command, ...invocation.args];
}

function trailingNewline(text) {
  if (text === '') return '';
  return text.endsWith('\n') ? '' : '\n';
}

function splitMarked(text, begin, end) {
  const startAt = text.indexOf(begin);
  if (startAt === -1) return { hasBlock: false, before: text, after: '' };
  const endAt = text.indexOf(end, startAt);
  if (endAt === -1) return { hasBlock: false, unterminated: true, before: text, after: '' };
  return { hasBlock: true, before: text.slice(0, startAt), after: text.slice(endAt + end.length) };
}

function appendBlock(text, block) {
  const body = text.trimEnd();
  return `${body}${body === '' ? '' : '\n\n'}${block}\n`;
}

function replaceMarkedBlock(text, begin, end, block) {
  const split = splitMarked(text, begin, end);
  if (split.unterminated) return { text, changed: false, reason: 'unterminated-block' };
  if (!split.hasBlock) return { text: appendBlock(text, block), changed: true, reason: 'appended' };
  const merged = `${split.before}${block}${split.after}`;
  if (merged === text) return { text, changed: false, reason: UNCHANGED };
  return { text: merged, changed: true, reason: 'updated' };
}

function neovimDropIn(invocation) {
  return [
    `-- Written by glissa; edit glissa's config, not this file. Delete it to unwire ${MARKER_NAME}.`,
    "vim.api.nvim_create_autocmd('FileType', {",
    "  pattern = 'markdown',",
    `  callback = function()`,
    `    vim.lsp.start({ name = '${SERVER_ID}', cmd = { ${parts(invocation).map((part) => `'${part}'`).join(', ')} } })`,
    '  end,',
    '})',
    '',
  ].join('\n');
}

function helixServerLines(invocation) {
  return [
    HELIX_BEGIN,
    `[language-server.${SERVER_ID}]`,
    `command = "${invocation.command}"`,
    `args = ${JSON.stringify(invocation.args)}`,
  ];
}

function helixServerBlock(invocation) {
  return [...helixServerLines(invocation), HELIX_END].join('\n');
}

function helixFullBlock(invocation) {
  return [
    ...helixServerLines(invocation),
    '',
    '[[language]]',
    'name = "markdown"',
    `language-servers = ["marksman", "${SERVER_ID}"]`,
    HELIX_END,
  ].join('\n');
}

// Helix keeps language servers in a per-language list, so ours is added to the markdown entry the
// operator already has rather than a second entry that would silently replace theirs.
function addToHelixMarkdown(text) {
  const lines = text.split('\n');
  let inMarkdown = false;
  let sawMarkdownLanguage = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '[[language]]') {
      inMarkdown = false;
      continue;
    }
    if (line.startsWith('[') && line !== '[[language]]') {
      inMarkdown = false;
      continue;
    }
    if (/^name\s*=\s*"markdown"\s*$/.test(line)) {
      inMarkdown = true;
      sawMarkdownLanguage = true;
      continue;
    }
    if (!inMarkdown || !/^language-servers\s*=\s*\[/.test(line)) continue;
    if (line.includes(`"${SERVER_ID}"`)) return { lines, sawMarkdownLanguage, changed: false };
    const isEmptyArray = /\[\s*\]\s*$/.test(line);
    lines[index] = isEmptyArray
      ? lines[index].replace(/\[\s*\]\s*$/, `["${SERVER_ID}"]`)
      : lines[index].replace(/\]\s*$/, `, "${SERVER_ID}"]`);
    return { lines, sawMarkdownLanguage, changed: true };
  }
  return { lines, sawMarkdownLanguage, changed: false };
}

function helixMerge(existingText, invocation) {
  const text = typeof existingText === 'string' ? existingText : '';
  const split = splitMarked(text, HELIX_BEGIN, HELIX_END);
  if (split.unterminated) return { text, changed: false, reason: 'unterminated-block' };

  // Detection runs on the file MINUS our own block, or the markdown entry we wrote last time reads as
  // the operator's and our block shrinks to a server definition their file no longer carries.
  const beforeEdit = addToHelixMarkdown(split.before);
  const afterEdit = addToHelixMarkdown(split.after);
  const ownsMarkdown = beforeEdit.sawMarkdownLanguage || afterEdit.sawMarkdownLanguage;
  const block = ownsMarkdown ? helixServerBlock(invocation) : helixFullBlock(invocation);

  const before = beforeEdit.lines.join('\n');
  const after = afterEdit.lines.join('\n');
  if (split.hasBlock) {
    const merged = `${before}${block}${after}`;
    if (merged === text) return { text, changed: false, reason: UNCHANGED };
    return { text: merged, changed: true, reason: 'updated' };
  }
  const merged = appendBlock(`${before}${after}`, block);
  if (merged === text) return { text, changed: false, reason: UNCHANGED };
  return { text: merged, changed: true, reason: 'appended' };
}

function removeFromHelixMarkdown(text) {
  const lines = text.split('\n');
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*language-servers\s*=\s*\[/.test(lines[index]) || !lines[index].includes(`"${SERVER_ID}"`)) continue;
    // Sole entry included: dropping it leaves an empty list, which is what the operator had.
    lines[index] = lines[index].replace(new RegExp(`\\s*,\\s*"${SERVER_ID}"|"${SERVER_ID}"\\s*,\\s*|"${SERVER_ID}"`), '');
    changed = true;
  }
  return { text: lines.join('\n'), changed };
}

function helixRemove(existingText) {
  const text = typeof existingText === 'string' ? existingText : '';
  const split = splitMarked(text, HELIX_BEGIN, HELIX_END);
  // A half-written block is refused whole, or unwiring would strip our server from their language list
  // and leave the dangling block that names it behind.
  if (split.unterminated) return { text, changed: false, reason: 'unterminated-block' };
  const stripped = split.hasBlock ? `${split.before.trimEnd()}\n${split.after.replace(/^\n+/, '')}` : text;
  const cleaned = removeFromHelixMarkdown(stripped);
  if (cleaned.text === text) return { text, changed: false, reason: UNCHANGED };
  return { text: cleaned.text, changed: true, reason: 'removed' };
}

function emacsRemove(existingText) {
  const text = typeof existingText === 'string' ? existingText : '';
  const split = splitMarked(text, EMACS_BEGIN, EMACS_END);
  if (split.unterminated) return { text, changed: false, reason: 'unterminated-block' };
  if (!split.hasBlock) return { text, changed: false, reason: UNCHANGED };
  return { text: `${split.before.trimEnd()}\n${split.after.replace(/^\n+/, '')}`, changed: true, reason: 'removed' };
}

function jsonSettingsRemove(existingText, { path: keyPath }) {
  const parsed = parseJsonSettings(existingText);
  if (!parsed.ok) return { text: existingText, changed: false, reason: parsed.reason };
  let cursor = parsed.value;
  for (const key of keyPath.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object') return { text: existingText, changed: false, reason: UNCHANGED };
    cursor = cursor[key];
  }
  const lastKey = keyPath[keyPath.length - 1];
  if (!(lastKey in cursor)) return { text: existingText, changed: false, reason: UNCHANGED };
  delete cursor[lastKey];
  return { text: `${JSON.stringify(parsed.value, null, 2)}\n`, changed: true, reason: 'removed' };
}

function emacsMerge(existingText, invocation) {
  const text = typeof existingText === 'string' ? existingText : '';
  const block = [
    EMACS_BEGIN,
    ";; Written by glissa. Delete this block to unwire glissa-visions.",
    "(with-eval-after-load 'eglot",
    "  (add-to-list 'eglot-server-programs",
    `               '(markdown-mode . (${parts(invocation).map((part) => `"${part}"`).join(' ')}))))`,
    EMACS_END,
  ].join('\n');
  return replaceMarkedBlock(text, EMACS_BEGIN, EMACS_END, block);
}

function parseJsonSettings(existingText) {
  const text = typeof existingText === 'string' ? existingText.trim() : '';
  if (text === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not-an-object' };
    return { ok: true, value };
  } catch {
    // Sublime and Kate both tolerate comments the strict parser does not, and a rewrite would drop them.
    return { ok: false, reason: 'unparseable' };
  }
}

// Only the one key naming our server is written; every sibling setting round-trips untouched.
function jsonSettingsMerge(existingText, { path: keyPath, value }) {
  const parsed = parseJsonSettings(existingText);
  if (!parsed.ok) return { text: existingText, changed: false, reason: parsed.reason };

  const settings = parsed.value;
  let cursor = settings;
  for (const key of keyPath.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  const lastKey = keyPath[keyPath.length - 1];
  if (JSON.stringify(cursor[lastKey]) === JSON.stringify(value)) return { text: existingText, changed: false, reason: UNCHANGED };
  cursor[lastKey] = value;
  return { text: `${JSON.stringify(settings, null, 2)}\n`, changed: true, reason: 'merged' };
}

function sublimeSettings(invocation) {
  return {
    path: ['clients', SERVER_ID],
    value: { enabled: true, command: parts(invocation), selector: 'text.html.markdown' },
  };
}

function kateSettings(invocation) {
  return {
    path: ['servers', 'markdown'],
    value: { command: parts(invocation), highlightingModeRegex: '^Markdown$' },
  };
}

module.exports = {
  SERVER_ID,
  emacsMerge,
  emacsRemove,
  helixMerge,
  helixRemove,
  jsonSettingsMerge,
  jsonSettingsRemove,
  kateSettings,
  neovimDropIn,
  sublimeSettings,
};
