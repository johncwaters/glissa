'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The project-side <outputPath>/ convention for a team (outputPath defaults to .glissa/teams/<id> so
// everything glissa writes into a target repo lives under .glissa/). See
// .omc/plans/glissa-teams-project-portability.md:
//   <outputPath>/pack/   project-OWNED inputs (voice-guide, avoid-list, brand, calendar, channels)
//   <outputPath>/runs/   generated run folders (committed back via team-git on a terminal outcome)
//   <outputPath>/log.md  append-only run log
// Glissa owns the agents (teams/<id>/agents + pack-templates in the glissa repo); the project owns the
// pack. All operations are NON-destructive: an existing pack file or prior run folder is never overwritten.

// A pack file still containing this sentinel is treated as unfilled, so the first run halts for setup.
const PACK_SENTINEL = 'GLISSA:NEEDS-INPUT';

// The pack files a content team needs by default; a team may override via team.json `pack.required`.
const DEFAULT_PACK_FILES = ['voice-guide.md', 'avoid-list.md', 'brand.md', 'content-calendar.md', 'channels.md'];

const LOG_HEADER = '# Team run log\n';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Escape a string for literal use inside a RegExp (shared by the markdown-section matchers below and
// by team-orchestrator's verdict/section parsing).
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Per-repo paths for a team, all under <projectPath>/<outputPath>/.
function teamPaths(projectPath, outputPath) {
  const base = path.join(projectPath, outputPath);
  return {
    base,
    packDir: path.join(base, 'pack'),
    runsDir: path.join(base, 'runs'),
    logPath: path.join(base, 'log.md'),
  };
}

// Create the run tree (base + runs + log) without touching the pack. The pack is scaffoldPack's job.
function ensureStructure(projectPath, outputPath) {
  const p = teamPaths(projectPath, outputPath);
  fs.mkdirSync(p.runsDir, { recursive: true });
  if (!fs.existsSync(p.logPath)) fs.writeFileSync(p.logPath, LOG_HEADER, 'utf8');
  return p;
}

// Copy each required pack file from the glissa-owned templatesDir into the project's pack/ folder, but
// only when the destination does not already exist (so an edited pack is never clobbered). Also seeds a
// pack README. Run outputs are committed by team-git, so the pack is NOT gitignored. Returns
// { created, packDir }.
function scaffoldPack(projectPath, outputPath, templatesDir, requiredFiles = DEFAULT_PACK_FILES) {
  const { packDir } = teamPaths(projectPath, outputPath);
  fs.mkdirSync(packDir, { recursive: true });
  const created = [];
  for (const name of requiredFiles) {
    const dest = path.join(packDir, name);
    if (fs.existsSync(dest)) continue;
    const src = templatesDir ? path.join(templatesDir, name) : null;
    if (src && fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else {
      // Defensive fallback: a required file with no shipped template still gets a fillable stub.
      fs.writeFileSync(dest, `# ${name}\n\n<!-- ${PACK_SENTINEL}: fill this in. -->\n`, 'utf8');
    }
    created.push(name);
  }
  const readmeDest = path.join(packDir, 'README.md');
  if (!fs.existsSync(readmeDest)) {
    const readmeSrc = templatesDir ? path.join(templatesDir, 'README.md') : null;
    if (readmeSrc && fs.existsSync(readmeSrc)) {
      fs.copyFileSync(readmeSrc, readmeDest);
    } else {
      fs.writeFileSync(
        readmeDest,
        `# Team pack\n\nProject-owned inputs for this team. Replace the ${PACK_SENTINEL} markers,`
          + ' then run the team again.\n',
        'utf8',
      );
    }
    created.push('README.md');
  }
  return { created, packDir };
}

// Whether the project pack is ready: every required file exists and none still carries the sentinel.
function packStatus(projectPath, outputPath, requiredFiles = DEFAULT_PACK_FILES) {
  const { packDir } = teamPaths(projectPath, outputPath);
  const missing = [];
  const unfilled = [];
  for (const name of requiredFiles) {
    const fp = path.join(packDir, name);
    if (!fs.existsSync(fp)) {
      missing.push(name);
      unfilled.push(name);
      continue;
    }
    let text = '';
    try { text = fs.readFileSync(fp, 'utf8'); } catch { /* unreadable counts as unfilled */ }
    if (!text || text.includes(PACK_SENTINEL)) unfilled.push(name);
  }
  return {
    configured: unfilled.length === 0, missing, unfilled, packDir,
  };
}

// Local-time "YYYY-MM-DD-weekday" label.
function runFolderLabel(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}-${WEEKDAYS[date.getDay()]}`;
}

// Create a fresh dated run folder, suffixing -2/-3/... on collision (never clobbers a prior run).
function createRunFolder(projectPath, outputPath, label) {
  const { runsDir } = teamPaths(projectPath, outputPath);
  fs.mkdirSync(runsDir, { recursive: true });
  const baseLabel = label || runFolderLabel();
  let candidate = baseLabel;
  let n = 2;
  while (fs.existsSync(path.join(runsDir, candidate))) {
    candidate = `${baseLabel}-${n}`;
    n += 1;
  }
  const full = path.join(runsDir, candidate);
  fs.mkdirSync(full);
  return full;
}

// Verify a handoff file exists and contains every required section as a markdown heading.
// Returns { ok, missing }.
function verifyHandoff(filePath, requiredSections = []) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, missing: [...requiredSections] };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const missing = requiredSections.filter((section) => {
    const esc = escapeRegExp(section);
    return !new RegExp(`^#{1,6}\\s*${esc}\\b`, 'im').test(text);
  });
  return { ok: missing.length === 0, missing };
}

// Append exactly one line to the append-only log (newlines in the line are flattened to spaces).
function appendLog(projectPath, outputPath, line) {
  const { logPath } = teamPaths(projectPath, outputPath);
  if (!fs.existsSync(logPath)) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, LOG_HEADER, 'utf8');
  }
  const oneLine = String(line).replace(/\r?\n/g, ' ').trimEnd();
  fs.appendFileSync(logPath, `${oneLine}\n`, 'utf8');
}

// Topics from the last n log entries. Log lines are pipe-delimited:
// "YYYY-MM-DD | topic | platforms | verdict | ...". Header/comment lines (starting with #) skipped.
function parseRecentTopics(projectPath, outputPath, n = 5) {
  const { logPath } = teamPaths(projectPath, outputPath);
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines
    .slice(-n)
    .map((l) => {
      const parts = l.split('|');
      return parts.length >= 2 ? parts[1].trim().toLowerCase() : '';
    })
    .filter(Boolean);
}

// The last n log entries (raw lines), newest last; header/comment lines skipped.
function readRecentLog(projectPath, outputPath, n = 10) {
  const { logPath } = teamPaths(projectPath, outputPath);
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines.slice(-n);
}

function clip(value, max) {
  const t = String(value || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// The paragraph (joined non-empty lines) directly under a markdown heading.
function readParagraph(text, heading) {
  if (!text) return '';
  const esc = escapeRegExp(heading);
  const m = new RegExp(`^#{1,6}\\s*${esc}\\b.*$`, 'im').exec(text);
  if (!m) return '';
  const lines = [];
  for (const raw of text.slice(m.index + m[0].length).split(/\r?\n/)) {
    const t = raw.trim();
    if (/^#{1,6}\s/.test(t)) break; // next heading
    if (t === '' && lines.length) break; // end of paragraph
    if (t) lines.push(t.replace(/^[-*]\s*/, ''));
  }
  return lines.join(' ');
}

// Summarize recent runs from their on-disk artifacts (newest first).
function listRunSummaries(projectPath, outputPath, stages = [], limit = 10) {
  const { runsDir } = teamPaths(projectPath, outputPath);
  if (!fs.existsSync(runsDir)) return [];
  const folders = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
    .slice(0, limit);

  return folders.map((runId) => {
    const dir = path.join(runsDir, runId);
    const reached = [];
    let topic = '';
    let platforms = '';
    let verdict = '';
    let summary = '';
    for (const stage of stages) {
      if (!stage || !stage.produces) continue;
      const fp = path.join(dir, stage.produces);
      if (!fs.existsSync(fp)) continue;
      reached.push(stage.id);
      let text = '';
      try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      if (!topic) topic = clip(readParagraph(text, 'Topic'), 140);
      if (!platforms) platforms = clip(readParagraph(text, 'Platforms'), 140);
      const v = /VERDICT:\s*([A-Za-z]+)/i.exec(text);
      if (v) {
        verdict = v[1].toUpperCase();
        summary = clip(readParagraph(text, 'Summary'), 320);
      }
    }
    return {
      runId, topic, platforms, verdict, summary, reached,
    };
  });
}

module.exports = {
  teamPaths,
  ensureStructure,
  scaffoldPack,
  packStatus,
  runFolderLabel,
  createRunFolder,
  verifyHandoff,
  appendLog,
  parseRecentTopics,
  readRecentLog,
  readParagraph,
  listRunSummaries,
  escapeRegExp,
  PACK_SENTINEL,
  DEFAULT_PACK_FILES,
};
