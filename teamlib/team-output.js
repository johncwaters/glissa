'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hasHeading, readParagraph } = require('./markdown');
const { extractVerdictToken } = require('./verdict');

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

// The project-level shared pack: cross-team setup files (voice-guide, avoid-list, brand) live here once
// per project and are reused by every team that declares the file in team.json `pack.shared`, instead of
// being re-filled in each team's own pack. Sibling of `.glissa/teams/`.
const SHARED_PACK_DIRNAME = path.join('.glissa', 'pack');

const LOG_HEADER = '# Team run log\n';
// First line of a run's chat.md. Not a chat marker, so readChat ignores it.
const CHAT_HEADER = '# Team conversation\n\n';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

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

// Pick a template source for `name`: the team's own templatesDir if it has the file, else the shared
// fallbackTemplatesDir if set and it has the file, else null (caller writes a sentinel stub).
function pickTemplate(name, templatesDir, fallbackTemplatesDir) {
  const local = templatesDir ? path.join(templatesDir, name) : null;
  if (local && fs.existsSync(local)) return local;
  const shared = fallbackTemplatesDir ? path.join(fallbackTemplatesDir, name) : null;
  if (shared && fs.existsSync(shared)) return shared;
  return null;
}

// A file is "filled" when it exists, is non-empty, and no longer carries the setup sentinel. Used by the
// pack status check AND by the shared-pack promotion (a filled team-local copy is promotable; a sentinel
// stub is not). Unreadable or missing counts as not filled.
function isFilled(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return !!text && !text.includes(PACK_SENTINEL);
  } catch {
    return false;
  }
}

// Resolve where each required pack file physically lives for a (project, team). This is the ONE source of
// truth every consumer (scaffold, status, setup, orchestrator, backend, git) uses, so the team-local pack
// dir is defined once (reusing teamPaths) and the shared-vs-local decision is a single set-membership test.
//   sharedPackDir = <projectPath>/.glissa/pack            (project-level, reused across teams)
//   packDir       = teamPaths(projectPath, outputPath).packDir   (team-local, unchanged)
//   files: one entry per requiredFiles name, IN ORDER, { name, path, scope } where a shared file resolves
//          under sharedPackDir and everything else under packDir. With sharedFiles=[] every file is local,
//          so the result is byte-identical to the pre-shared-pack behavior.
function resolvePackLayout(projectPath, outputPath, requiredFiles = DEFAULT_PACK_FILES, sharedFiles = []) {
  const sharedSet = new Set(sharedFiles || []);
  const sharedPackDir = path.join(projectPath, SHARED_PACK_DIRNAME);
  const { packDir } = teamPaths(projectPath, outputPath);
  const files = (requiredFiles || []).map((name) => {
    const scope = sharedSet.has(name) ? 'shared' : 'local';
    const dir = scope === 'shared' ? sharedPackDir : packDir;
    return { name, path: path.join(dir, name), scope };
  });
  return { sharedPackDir, packDir, files };
}

// Copy each required pack file into its resolved location (shared files into <project>/.glissa/pack/, the
// rest into the team-local pack/), but only when the destination does not already exist (so an edited pack
// is never clobbered). A local file resolves its template templatesDir -> fallbackTemplatesDir -> stub; a
// SHARED file templates ONLY from fallbackTemplatesDir (it is project-level, not team-flavored). Also seeds
// a team-local pack README. Run outputs are committed by team-git, so the pack is NOT gitignored.
//
// Migration (B1, non-destructive): when a shared file is absent in the shared dir but a FILLED team-local
// copy exists, that copy is PROMOTED up to the shared dir (recorded in `promoted`) instead of writing a
// stub, so an operator who already filled a now-shared file is never re-prompted. If the shared copy
// already exists and a filled team-local copy DIFFERS from it, the divergence is recorded in `divergent`
// (first-write wins, the loser is left on disk for manual reconcile, nothing is deleted or auto-merged).
// Returns { created, promoted, divergent, packDir, sharedPackDir }.
function scaffoldPack(
  projectPath, outputPath, templatesDir,
  requiredFiles = DEFAULT_PACK_FILES, fallbackTemplatesDir = null, sharedFiles = [],
) {
  const { packDir, sharedPackDir, files } = resolvePackLayout(projectPath, outputPath, requiredFiles, sharedFiles);
  fs.mkdirSync(packDir, { recursive: true });
  const created = [];
  const promoted = [];
  const divergent = [];
  const stub = (dest, name) => fs.writeFileSync(dest, `# ${name}\n\n<!-- ${PACK_SENTINEL}: fill this in. -->\n`, 'utf8');
  const copyOrStub = (src, dest, name) => {
    if (src) {
      fs.copyFileSync(src, dest);
      return;
    }
    stub(dest, name);
  };

  for (const file of files) {
    const dest = file.path;
    const teamLocalPath = path.join(packDir, file.name);
    if (fs.existsSync(dest)) {
      // Already present: never clobber. For a shared file, flag a filled team-local copy that diverges
      // from the canonical shared copy so the abandoned version is discoverable, not silently lost.
      if (file.scope === 'shared' && teamLocalPath !== dest && isFilled(teamLocalPath)) {
        try {
          if (fs.readFileSync(dest, 'utf8') !== fs.readFileSync(teamLocalPath, 'utf8')) {
            divergent.push({ name: file.name, teamLocalPath });
          }
        } catch { /* unreadable -> not reported */ }
      }
      continue;
    }
    if (file.scope === 'shared') {
      fs.mkdirSync(sharedPackDir, { recursive: true });
      // Promote a pre-existing filled team-local copy rather than overwriting it with a fresh stub.
      if (teamLocalPath !== dest && isFilled(teamLocalPath)) {
        fs.copyFileSync(teamLocalPath, dest);
        promoted.push({ name: file.name, from: teamLocalPath });
        created.push(file.name);
        continue;
      }
      const src = fallbackTemplatesDir ? path.join(fallbackTemplatesDir, file.name) : null;
      copyOrStub(src && fs.existsSync(src) ? src : null, dest, file.name);
      created.push(file.name);
      continue;
    }
    // Local file: unchanged behavior (team templatesDir -> shared fallback -> stub).
    copyOrStub(pickTemplate(file.name, templatesDir, fallbackTemplatesDir), dest, file.name);
    created.push(file.name);
  }

  const readmeDest = path.join(packDir, 'README.md');
  if (!fs.existsSync(readmeDest)) {
    const readmeSrc = pickTemplate('README.md', templatesDir, fallbackTemplatesDir);
    const readmeText = readmeSrc
      ? fs.readFileSync(readmeSrc, 'utf8')
      : `# Team pack\n\nProject-owned inputs for this team. Replace the ${PACK_SENTINEL} markers,`
        + ' then run the team again.\n';
    fs.writeFileSync(readmeDest, readmeText, 'utf8');
    created.push('README.md');
  }
  return {
    created, promoted, divergent, packDir, sharedPackDir,
  };
}

// Whether the project pack is ready: every required file exists and none still carries the sentinel.
// A shared file (in sharedFiles) is checked in <project>/.glissa/pack/, so once it is filled once every
// team that shares it reports configured. With sharedFiles=[] this is byte-identical to the team-local check.
function packStatus(projectPath, outputPath, requiredFiles = DEFAULT_PACK_FILES, sharedFiles = []) {
  const { files, packDir, sharedPackDir } = resolvePackLayout(projectPath, outputPath, requiredFiles, sharedFiles);
  const missing = [];
  const unfilled = [];
  for (const file of files) {
    if (!fs.existsSync(file.path)) {
      missing.push(file.name);
      unfilled.push(file.name);
      continue;
    }
    let text = '';
    try { text = fs.readFileSync(file.path, 'utf8'); } catch { /* unreadable counts as unfilled */ }
    if (!text || text.includes(PACK_SENTINEL)) unfilled.push(file.name);
  }
  return {
    configured: unfilled.length === 0, missing, unfilled, packDir, sharedPackDir,
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

// ── Run conversation transcript (chat.md) ─────────────────────
// The per-run operator/agent transcript. It is simultaneously the durable record (committed back with
// the run folder), the rehydration source for the Teams chat pane, and the context injected into later
// stages. Only operator + agent turns are stored here; UI-only lifecycle lines are NOT persisted.

function chatPath(runDir) {
  return path.join(runDir, 'chat.md');
}

// Append one conversation turn and return the stored entry (with ts filled). role is normalized to
// 'operator' or 'agent'. The record is delimited by an HTML comment so it stays human-readable for the
// agents that read the file AND machine-parseable by readChat.
function appendChat(runDir, entry = {}) {
  const role = entry.role === 'agent' ? 'agent' : 'operator';
  const stage = entry.stage ? String(entry.stage) : '';
  const ts = entry.ts || new Date().toISOString();
  const text = String(entry.text == null ? '' : entry.text);
  const file = chatPath(runDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, CHAT_HEADER, 'utf8');
  const marker = `<!-- glissa-chat role=${role} stage=${stage} ts=${ts} -->`;
  // Neutralize any body line that would collide with a record marker (indent it one space), so readChat
  // never mis-splits a multi-line turn into forged turns. The anchored regex below then cannot match it.
  const safeText = text.trimEnd().replace(/^(<!-- glissa-chat )/gm, ' $1');
  fs.appendFileSync(file, `${marker}\n${safeText}\n\n`, 'utf8');
  return {
    role, stage: stage || null, ts, text,
  };
}

// Parse chat.md into [{role, stage, ts, text}] (oldest first). Tolerant: a missing/unreadable file or a
// file with no markers yields []. Lines before the first marker (the header) are ignored.
function readChat(runDir) {
  const file = chatPath(runDir);
  if (!fs.existsSync(file)) return [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const markerRe = /^<!-- glissa-chat role=(\w+) stage=([^\s]*) ts=(\S+) -->$/;
  const out = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = markerRe.exec(line);
    if (m) {
      if (cur) { cur.text = cur.text.join('\n').trim(); out.push(cur); }
      cur = {
        role: m[1], stage: m[2] || null, ts: m[3], text: [],
      };
      continue;
    }
    if (cur) cur.text.push(line);
  }
  if (cur) { cur.text = cur.text.join('\n').trim(); out.push(cur); }
  return out;
}

// Archive a round's handoff artifacts before the next revise round overwrites the canonical files.
// For each name in `files`, if runDir/<name> exists, copy it to runDir/rounds/r<round>-<name>. The
// rounds/ dir is created recursively. NON-destructive: an existing archive copy is never overwritten
// (it is skipped). Returns the array of archive dest paths actually written.
function archiveRoundArtifacts(runDir, round, files = []) {
  const roundsDir = path.join(runDir, 'rounds');
  const archived = [];
  for (const name of files) {
    if (!name) continue;
    const src = path.join(runDir, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(roundsDir, `r${round}-${name}`);
    if (fs.existsSync(dest)) continue; // never clobber a prior archive
    fs.mkdirSync(roundsDir, { recursive: true });
    fs.copyFileSync(src, dest);
    archived.push(dest);
  }
  return archived;
}

// Verify a handoff file exists and contains every required section as a markdown heading.
// Returns { ok, missing }.
function verifyHandoff(filePath, requiredSections = []) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, missing: [...requiredSections] };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const missing = requiredSections.filter((section) => !hasHeading(text, section));
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

// U+2026 built with fromCharCode: the repo bans raw dash/ellipsis literals in source (editor tooling
// mangles them), but the truncation marker itself should stay a single ellipsis glyph in the UI.
const ELLIPSIS = String.fromCharCode(0x2026);
function clipDisplayText(value, max) {
  const t = String(value || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}${ELLIPSIS}` : t;
}

// Summarize recent runs from their on-disk artifacts (newest first). Async on purpose: this serves a
// dashboard request (get-team-runs) and reads up to limit x stages files; sync reads here block every
// live session's PTY streaming on the shared event loop.
async function listRunSummaries(projectPath, outputPath, stages = [], limit = 10) {
  const { runsDir } = teamPaths(projectPath, outputPath);
  const entries = await fs.promises.readdir(runsDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const folders = entries
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
    .slice(0, limit);

  const summaries = [];
  for (const runId of folders) {
    const dir = path.join(runsDir, runId);
    const reached = [];
    // Config-driven, per team.json stage.capture (section + slot): the orchestrator's run-log line
    // (team-orchestrator.js) reads the same stage.capture config, so a heading name is declared once
    // per team instead of hardcoded here as "Topic"/"Platforms" (which only the marketing team has).
    // A team with no capture-declaring stage (changelog, qa, qa-walk) simply reports neither field.
    const captured = { topic: '', platforms: '' };
    let verdict = '';
    let summary = '';
    for (const stage of stages) {
      if (!stage || !stage.produces) continue;
      const fp = path.join(dir, stage.produces);
      // A present-but-unreadable artifact still counts as reached (matches the old existsSync gate).
      const st = await fs.promises.stat(fp).catch(() => null);
      if (!st) continue;
      reached.push(stage.id);
      let text = '';
      try { text = await fs.promises.readFile(fp, 'utf8'); } catch { continue; }
      if (stage.capture && !captured[stage.capture.slot]) {
        captured[stage.capture.slot] = clipDisplayText(readParagraph(text, stage.capture.section), 140);
      }
      const v = extractVerdictToken(text);
      if (v) {
        verdict = v;
        summary = clipDisplayText(readParagraph(text, 'Summary'), 320);
      }
    }
    const chat = await fs.promises.access(path.join(dir, 'chat.md')).then(() => true, () => false);
    summaries.push({
      runId, topic: captured.topic, platforms: captured.platforms, verdict, summary, reached, chat,
    });
  }
  return summaries;
}

module.exports = {
  teamPaths,
  ensureStructure,
  resolvePackLayout,
  scaffoldPack,
  packStatus,
  runFolderLabel,
  createRunFolder,
  chatPath,
  appendChat,
  readChat,
  archiveRoundArtifacts,
  verifyHandoff,
  appendLog,
  parseRecentTopics,
  listRunSummaries,
  PACK_SENTINEL,
  DEFAULT_PACK_FILES,
  SHARED_PACK_DIRNAME,
};
