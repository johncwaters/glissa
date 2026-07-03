'use strict';

// Pure parser/renderer for the deterministic first-run team-setup context. No fs, no I/O: every input is
// a raw string (or null/undefined) that the io shell (project-context.js) read off disk. Keeping this pure
// mirrors the repo's seam pattern (session/core/, *-core.mjs) so the whole parser is unit-testable without
// temp-dir fixtures. Output is ASCII-clean (no em/en dashes, no emoji) and deterministic: the same inputs
// always render the same summary, with no timestamps.

// Typographic characters this project forbids in any output. Built from char codes so no literal forbidden
// character (or unicode escape) appears in source: en dash U+2013, em dash U+2014, horizontal ellipsis
// U+2026. Scanned content (a README heading, a package description) may contain these; sanitize strips them
// so none ever leaks into the prompt.
const DASH_CHARS = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`, 'g');
const ELLIPSIS_CHAR = String.fromCharCode(0x2026);

// Collapse whitespace and strip the forbidden typographic characters. CRLF-tolerant (the whitespace
// collapse folds "\r\n"). Returns '' for empty input.
function sanitize(text) {
  if (!text) return '';
  return String(text)
    .replace(DASH_CHARS, '-')
    .split(ELLIPSIS_CHAR)
    .join('...')
    .replace(/\s+/g, ' ')
    .trim();
}

// Length cap that appends an ASCII "..." (never the U+2026 ellipsis char). Applied after sanitize.
function cap(text, max) {
  const t = String(text || '');
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

// Parse package.json text into the identity fields we surface. Malformed JSON yields {} (the io shell also
// guards, but the core tolerates junk so it is testable in isolation). `repository` may be a string or an
// object with `.url`; `author` may be a string or an object with `.name`.
function parsePackageJson(text) {
  if (!text) return {};
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return {};
  }
  if (!pkg || typeof pkg !== 'object') return {};
  const repo = pkg.repository;
  const repoUrl = typeof repo === 'string' ? repo : (repo && typeof repo === 'object' ? repo.url : '');
  const author = typeof pkg.author === 'string'
    ? pkg.author
    : (pkg.author && typeof pkg.author === 'object' ? pkg.author.name : '');
  return {
    name: typeof pkg.name === 'string' ? pkg.name : '',
    description: typeof pkg.description === 'string' ? pkg.description : '',
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage : '',
    repoUrl: typeof repoUrl === 'string' ? repoUrl : '',
    author: typeof author === 'string' ? author : '',
  };
}

// Extract the origin remote URL from raw .git/config text. The file is INI-ish: a `[remote "origin"]`
// header followed by an indented `url = ...`. CRLF-tolerant. The origin section wins even when another
// remote (for example `upstream`) is listed first. Returns '' when there is no origin url.
function parseGitConfigOrigin(configText) {
  if (!configText) return '';
  let inOrigin = false;
  for (const raw of String(configText).split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[(.+?)\]$/.exec(line);
    if (section) {
      const header = section[1].trim().toLowerCase().replace(/\s+/g, ' ');
      inOrigin = header === 'remote "origin"';
      continue;
    }
    if (inOrigin) {
      const m = /^url\s*=\s*(.+)$/i.exec(line);
      if (m) return m[1].trim();
    }
  }
  return '';
}

// Normalize a git remote URL to a canonical https form. Strips a leading "git+", converts scp-style
// `git@host:owner/repo(.git)` to `https://host/owner/repo`, and drops a trailing ".git". Idempotent;
// '' -> ''.
function normalizeRepoUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (u.startsWith('git+')) u = u.slice(4);
  // scp-style (git@github.com:owner/repo.git) only when there is no explicit scheme (skips ssh://...).
  if (!u.includes('://')) {
    const scp = /^[^@/]+@([^:]+):(.+)$/.exec(u);
    if (scp) u = `https://${scp[1]}/${scp[2]}`;
  }
  return u.replace(/\.git$/i, '');
}

// A README badge line: a markdown image `![alt](src)` or a linked image `[![alt](src)](href)`. These open
// most READMEs and are noise for the title, so the H1 fallback skips them.
const BADGE_LINE = /^\[?!\[/;
const ATX_H1 = /^#\s+(.+?)\s*#*\s*$/;

// The README's H1 title. CRLF-tolerant. Prefers the first ATX "# " heading; otherwise the first non-empty
// line that is not a badge; otherwise ''. The caller sanitizes/caps the result.
function extractH1(readmeText) {
  if (!readmeText) return '';
  const lines = String(readmeText).split(/\r?\n/);
  for (const raw of lines) {
    const m = ATX_H1.exec(raw.trim());
    if (m) return m[1].trim();
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || BADGE_LINE.test(line)) continue;
    return line;
  }
  return '';
}

// Strip a single pair of surrounding single or double quotes.
function unquote(s) {
  const t = String(s || '').trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1);
  }
  return t;
}

// Backfill identity from a static-site config (Jekyll _config.yml or Hugo config.toml) used only when there
// is no package.json. Line-regex only (NO yaml/toml parser; the repo adds no dependencies). Tolerates the
// YAML "key: value" and TOML "key = value" forms, quoted or unquoted, CRLF. Returns { name, description }.
function parseSiteConfig(siteConfigText) {
  if (!siteConfigText) return { name: '', description: '' };
  const lines = String(siteConfigText).split(/\r?\n/);
  const grab = (key) => {
    const re = new RegExp(`^${key}\\s*[:=]\\s*(.+)$`, 'i');
    for (const raw of lines) {
      const m = re.exec(raw.trim());
      if (m) return unquote(m[1].trim());
    }
    return '';
  };
  return { name: grab('title'), description: grab('description') };
}

// Compact, stable-ordered, timestamp-free markdown. Only non-empty fields are emitted, so a bare project
// renders '' (the prompt builder then injects no block). Deterministic: same fields -> byte-identical output.
function renderSummary(fields) {
  const f = fields || {};
  const rows = [];
  const title = f.name || f.readmeTitle;
  if (title) rows.push(`- Project: ${title}`);
  if (f.description) rows.push(`- Description: ${f.description}`);
  // Only add a README-title line when it differs from what the Project line already shows (it may have
  // been sourced from readmeTitle itself when name was empty).
  if (f.readmeTitle && f.readmeTitle !== title) rows.push(`- README title: ${f.readmeTitle}`);
  if (f.repoUrl) rows.push(`- Repository: ${f.repoUrl}`);
  if (f.homepage && f.homepage !== f.repoUrl) rows.push(`- Homepage: ${f.homepage}`);
  if (f.author) rows.push(`- Author: ${f.author}`);
  return rows.join('\n');
}

const CAPS = {
  name: 80, description: 200, homepage: 200, repoUrl: 200, author: 80, readmeTitle: 120,
};

// Merge the parsed sources into the identity fields with deterministic precedence:
//   name/description: package.json, else static-site config.
//   repoUrl: .git/config origin (normalized), else package.json repository.url (normalized), else homepage.
// Every value is sanitized (dash/emoji-free) and length-capped. Returns the fields plus a rendered summary.
function buildContext({
  packageJsonText, readmeText, gitConfigText, siteConfigText,
} = {}) {
  const pkg = parsePackageJson(packageJsonText);
  const site = parseSiteConfig(siteConfigText);
  const gitUrl = normalizeRepoUrl(parseGitConfigOrigin(gitConfigText));
  const pkgRepo = normalizeRepoUrl(pkg.repoUrl);

  const fields = {
    name: cap(sanitize(pkg.name || site.name), CAPS.name),
    description: cap(sanitize(pkg.description || site.description), CAPS.description),
    homepage: cap(sanitize(pkg.homepage), CAPS.homepage),
    repoUrl: cap(sanitize(gitUrl || pkgRepo || pkg.homepage), CAPS.repoUrl),
    author: cap(sanitize(pkg.author), CAPS.author),
    readmeTitle: cap(sanitize(extractH1(readmeText)), CAPS.readmeTitle),
  };
  return { ...fields, summary: renderSummary(fields) };
}

module.exports = {
  buildContext,
  sanitize,
  cap,
  parsePackageJson,
  parseGitConfigOrigin,
  normalizeRepoUrl,
  extractH1,
  parseSiteConfig,
  renderSummary,
};
