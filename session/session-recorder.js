'use strict';

/**
 * SessionRecorder - the always-on forensic log for a session.
 *
 * Two verbosity levels, one format (see AGENTS.md, "Session Recording"):
 *   - signals (default, every real session): header, hook (VERBATIM payloads, so
 *     background_tasks and friends survive), state transitions, decisions (the gate/notification
 *     trace), footer. Tiny, and it is exactly what a detection post-mortem needs.
 *   - full (opt-in via config.capture.enabled): the above plus raw PTY bytes, user input and
 *     resizes. Bulky; only replay-harness work needs it.
 *
 * Recording format (JSONL, one record per line):
 *
 * Format versions:
 *   v1 - legacy content-scraping era. Had a `detection` record from the old PatternDetector.
 *        No `hook` records. (Read-only for the replay harness.)
 *   v2 - structural-signal era (current). Adds a `hook` record; no `detection` record.
 *
 *   Header (first line):
 *     {"type":"header","version":2,"records":"signals"|"full","session":"name",
 *      "startedAt":ts,"config":{...},"cols":80,"rows":24}
 *
 *   Data (each PTY chunk; `full` only):
 *     {"type":"data","ts":epoch,"len":N,"data":"raw pty string"}
 *
 *   Hook (each Claude Code hook callback received for this session):
 *     {"type":"hook","ts":epoch,"event":"Stop","payload":{...}}
 *
 *   State (each successful state transition):
 *     {"type":"state","ts":epoch,"from":"STATE","to":"STATE","event":"...","detail":{...}}
 *
 *   Decision (each detection/gate/notification decision and its evidence):
 *     {"type":"decision","ts":epoch,"kind":"signal"|"gate"|"notify"|"notify-state",...}
 *
 *   Input (user writes to PTY; `full` only):
 *     {"type":"input","ts":epoch,"data":"..."}
 *
 *   Resize (`full` only):
 *     {"type":"resize","ts":epoch,"cols":N,"rows":N}
 *
 *   Footer (session end; `packReads` only when context packs were delivered):
 *     {"type":"footer","ts":epoch,"reason":"...","exitCode":N,
 *      "packReads":[{"name":"..","version":"..","reads":N,"lastReadAt":epoch,"readsSinceNotice":N}]}
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { safePathSegment } = require('../shared/paths');

// Recordings live beside config.json, never under the process cwd: recording is on by default now,
// and a cwd-relative directory would scatter forensic logs through whichever repo the server
// happened to be launched from.
const DEFAULT_BASE_DIR = path.join(os.homedir(), '.glissa', 'recordings');
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const DEFAULT_RETAIN_DAYS = 7;
// Per-session file cap, the bound that actually matters for a default-on recorder: one file per
// session start, so a session restarted all day cannot accumulate without limit.
const DEFAULT_RETAIN_FILES = 20;

class SessionRecorder {
  /**
   * @param {object} opts
   * @param {string} opts.name           Session name
   * @param {string} [opts.baseDir]      Recording directory (default: ~/.glissa/recordings)
   * @param {boolean} [opts.recordData]  Record raw PTY bytes / input / resizes (default: false)
   * @param {number} [opts.maxFileSize]  Bytes before rotation (default: 50MB)
   * @param {number} [opts.retainDays]   Age-based retention, <=0 disables (default: 7)
   * @param {number} [opts.retainFiles]  Per-session file cap, <=0 disables (default: 20)
   */
  constructor({ name, baseDir, recordData = false, maxFileSize, retainDays, retainFiles }) {
    this._name = name;
    this._safeName = safePathSegment(name);
    this._baseDir = baseDir || DEFAULT_BASE_DIR;
    this._recordData = !!recordData;
    this._maxFileSize = maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this._retainDays = retainDays != null ? retainDays : DEFAULT_RETAIN_DAYS;
    this._retainFiles = retainFiles != null ? retainFiles : DEFAULT_RETAIN_FILES;
    this._stream = null;
    this._filepath = null;
    this._currentSize = 0;
    this._opened = false;
    this._closed = false;
    this._disabled = false;
    // Resolves when the retention sweep started by open() has finished. Nothing in production
    // awaits it (pruning must never delay a spawn); tests do.
    this.retentionDone = Promise.resolve();
  }

  get recordsData() {
    return this._recordData;
  }

  /**
   * Open the recording file stream and kick off an async retention sweep. Idempotent, and called
   * lazily by the first write: a session that is only constructed (DORMANT, never started) must
   * not leave an empty recording behind.
   */
  open() {
    if (this._disabled || this._closed || this._opened) return;
    this._opened = true;
    try {
      fs.mkdirSync(this._baseDir, { recursive: true });
      this._openNewFile();
      this.retentionDone = this._cleanup();
    } catch (err) {
      this._disableWithWarning('open', err);
    }
  }

  writeHeader(config) {
    this._write({
      type: 'header',
      version: 2,
      records: this._recordData ? 'full' : 'signals',
      session: this._name,
      startedAt: Date.now(),
      config,
      cols: config.cols || 80,
      rows: config.rows || 24,
    });
  }

  writeData(data) {
    if (!this._recordData) return;
    this._write({ type: 'data', ts: Date.now(), len: data.length, data });
  }

  writeHook(event, payload) {
    this._write({ type: 'hook', ts: Date.now(), event, payload: payload || null });
  }

  writeState(from, to, event, detail) {
    this._write({ type: 'state', ts: Date.now(), from, to, event, detail: detail || null });
  }

  // The decision trace (session/core/decision-log.js): gate verdicts and notification decisions
  // with the evidence behind them. Tiny, and the exact thing a false-completion post-mortem needs,
  // so it rides the default signals mode alongside hooks and transitions.
  writeDecision(entry) {
    const e = entry || {};
    this._write({ type: 'decision', ts: e.ts || Date.now(), ...e });
  }

  writeInput(data) {
    if (!this._recordData) return;
    this._write({ type: 'input', ts: Date.now(), data });
  }

  writeResize(cols, rows) {
    if (!this._recordData) return;
    this._write({ type: 'resize', ts: Date.now(), cols, rows });
  }

  // `packReads` is the whole-session aggregate of the context-pack read telemetry. It rides the
  // footer because the per-read hook callbacks are deliberately NOT recorded at the signals level
  // (one record per Read would bury everything else); see sessions.js ingestHookSignal.
  writeFooter(reason, exitCode, summary) {
    const record = { type: 'footer', ts: Date.now(), reason, exitCode: exitCode != null ? exitCode : null };
    const packReads = summary && Array.isArray(summary.packReads) ? summary.packReads : [];
    if (packReads.length > 0) record.packReads = packReads;
    this._write(record);
  }

  /** Idempotent close - safe to call multiple times. */
  close() {
    if (this._closed || !this._stream) {
      this._closed = true;
      return;
    }
    this._closed = true;
    try {
      this._stream.end();
    } catch (_err) {
      // Best-effort close
    }
    this._stream = null;
  }

  // Private helpers

  _write(record) {
    if (this._disabled || this._closed) return;
    if (!this._opened) this.open();
    if (!this._stream) return;
    try {
      const line = `${JSON.stringify(record)}\n`;
      this._stream.write(line);
      this._currentSize += Buffer.byteLength(line, 'utf8');

      if (this._currentSize >= this._maxFileSize) {
        this._rotate();
      }
    } catch (err) {
      this._disableWithWarning('write', err);
    }
  }

  _openNewFile() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this._filepath = path.join(this._baseDir, `${this._safeName}-${ts}.jsonl`);
    this._stream = fs.createWriteStream(this._filepath, { flags: 'a' });
    this._currentSize = 0;

    // Handle stream errors silently to avoid crashing the session
    this._stream.on('error', (err) => {
      this._disableWithWarning('stream', err);
    });
  }

  _rotate() {
    try {
      if (this._stream) {
        this._stream.end();
      }
      this._openNewFile();
    } catch (err) {
      this._disableWithWarning('rotate', err);
    }
  }

  /**
   * Drop this session's oldest recordings past the file cap, and anyone's past retainDays.
   * Fully async (all sessions share one event loop) and best-effort: a locked file is skipped.
   */
  async _cleanup() {
    if (this._retainDays <= 0 && this._retainFiles <= 0) return;
    let entries;
    try {
      entries = await fsp.readdir(this._baseDir);
    } catch {
      return; // Directory may not exist yet
    }
    const recordings = entries.filter((e) => e.endsWith('.jsonl'));
    const doomed = new Set();

    if (this._retainFiles > 0) {
      const mine = recordings.filter((e) => e.startsWith(`${this._safeName}-`));
      // createWriteStream opens asynchronously, so the file this session just claimed may not be
      // in the listing yet; count it regardless, or the cap drifts by one on every open.
      const current = this._filepath ? path.basename(this._filepath) : null;
      if (current && !mine.includes(current)) mine.push(current);
      // ISO timestamps sort lexicographically, so newest-first is a plain reverse sort.
      mine.sort().reverse();
      for (const entry of mine.slice(this._retainFiles)) doomed.add(entry);
    }

    if (this._retainDays > 0) {
      const cutoff = Date.now() - (this._retainDays * 24 * 60 * 60 * 1000);
      for (const entry of recordings) {
        if (doomed.has(entry)) continue;
        try {
          const stat = await fsp.stat(path.join(this._baseDir, entry));
          if (stat.mtimeMs < cutoff) doomed.add(entry);
        } catch {
          // Skip locked or inaccessible files (Windows file handle issue)
        }
      }
    }

    for (const entry of doomed) {
      const filepath = path.join(this._baseDir, entry);
      if (filepath === this._filepath) continue; // never prune the file just opened
      try {
        await fsp.unlink(filepath);
      } catch {
        // Skip locked or inaccessible files
      }
    }
  }

  _disableWithWarning(context, err) {
    if (this._disabled) return;
    this._disabled = true;
    console.warn(`[session-recorder:${this._name}] Recording disabled (${context}): ${err.message}`);
    // Best-effort close the stream
    if (this._stream) {
      try { this._stream.end(); } catch { /* ignore */ }
      this._stream = null;
    }
  }
}

/**
 * Create a SessionRecorder for one session. Signal recording is ON by default (kill switch:
 * config `recordSignals`); raw PTY capture is opt-in via config `capture.enabled`.
 * Returns null only when both are off.
 *
 * @param {string} sessionName
 * @param {object} [captureConfig]   config.capture: { enabled, baseDir, maxFileSizeMB, retainDays, retainFiles }
 * @param {boolean} [recordSignals]  config.recordSignals (default true)
 * @returns {SessionRecorder|null}
 */
function createRecorder(sessionName, captureConfig, recordSignals = true) {
  const cfg = captureConfig || {};
  const recordData = !!cfg.enabled;
  if (!recordData && !recordSignals) return null;

  // Not opened here: the first record opens the file, so a session that never starts leaves nothing.
  return new SessionRecorder({
    name: sessionName,
    baseDir: cfg.baseDir,
    recordData,
    maxFileSize: cfg.maxFileSizeMB ? cfg.maxFileSizeMB * 1024 * 1024 : undefined,
    retainDays: cfg.retainDays,
    retainFiles: cfg.retainFiles,
  });
}

module.exports = { SessionRecorder, createRecorder };
