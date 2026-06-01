'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildContext } = require('./project-context-core');

// Deterministic, fs-only project context for first-run team setup. Reads a small, EXACT top-level
// allowlist of non-secret files and hands their raw text to the pure core (project-context-core.js), which
// does all parsing and renders the summary. TOTAL: always returns an object, never throws; each read is
// independently guarded. NO recursive directory walk (Windows-junction safe + deterministic). NEVER reads
// .env*, node_modules, or .git objects (only .git/config). The summary feeds buildSetupPrompt as advisory
// "starting facts"; an empty summary makes the prompt builder inject no block, so a bare project degrades
// to the original prompt.

// Cap the decoded README length so an enormous file cannot dominate memory or the prompt. Char-based
// (not byte-exact), which is sufficient for a determinism/size bound.
const README_MAX_CHARS = 64 * 1024;

// Read a UTF-8 file, returning null on any error (missing, unreadable, or a directory). An optional length
// cap is applied to the decoded string.
function readTextSafe(filePath, maxChars = 0) {
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    let text = fs.readFileSync(filePath, 'utf8');
    if (maxChars > 0 && text.length > maxChars) text = text.slice(0, maxChars);
    return text;
  } catch {
    return null;
  }
}

// First readable file from a list of top-level candidate names (case variants), or null.
function firstExisting(projectPath, names, maxChars = 0) {
  for (const name of names) {
    const text = readTextSafe(path.join(projectPath, name), maxChars);
    if (text != null) return text;
  }
  return null;
}

// Scan a project for deterministic identity facts. `projectPath` may be missing/invalid; the result is
// always { name, description, homepage, repoUrl, author, readmeTitle, summary } and never throws.
function scanProjectContext(projectPath) {
  const base = String(projectPath || '');
  if (!base) return buildContext({});

  const packageJsonText = readTextSafe(path.join(base, 'package.json'));
  const readmeText = firstExisting(base, ['README.md', 'README', 'readme.md'], README_MAX_CHARS);
  const gitConfigText = readTextSafe(path.join(base, '.git', 'config'));
  // The static-site identity fallback is consulted only when package.json is absent or empty.
  const needSite = !packageJsonText || !packageJsonText.trim();
  const siteConfigText = needSite
    ? (readTextSafe(path.join(base, '_config.yml')) || readTextSafe(path.join(base, 'config.toml')))
    : null;

  return buildContext({
    packageJsonText, readmeText, gitConfigText, siteConfigText,
  });
}

module.exports = { scanProjectContext };
