'use strict';

/**
 * SessionRecorder — always-on JSONL recorder for PTY session data.
 *
 * Recording format (JSONL, one record per line):
 *
 * Format versions:
 *   v1 — legacy content-scraping era. Had a `detection` record
 *        ({"type":"detection","layer","pattern","line","pending"}) from the old
 *        PatternDetector. No `hook` records. (Read-only for the replay harness.)
 *   v2 — structural-signal era (current). Adds a `hook` record; no `detection` record.
 *
 *   Header (first line):
 *     {"type":"header","version":2,"session":"name","startedAt":ts,"config":{...},"cols":80,"rows":24}
 *
 *   Data (each PTY chunk):
 *     {"type":"data","ts":epoch,"len":N,"data":"raw pty string"}
 *
 *   Hook (v2; each Claude Code hook callback received for this session):
 *     {"type":"hook","ts":epoch,"event":"Stop","payload":{...}}
 *
 *   State (each successful state transition):
 *     {"type":"state","ts":epoch,"from":"STATE","to":"STATE","event":"...","detail":{...}}
 *
 *   Input (user writes to PTY):
 *     {"type":"input","ts":epoch,"data":"..."}
 *
 *   Resize:
 *     {"type":"resize","ts":epoch,"cols":N,"rows":N}
 *
 *   Footer (session end):
 *     {"type":"footer","ts":epoch,"reason":"...","exitCode":N}
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CAPTURE_DIR = '.pty-capture';
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const DEFAULT_RETAIN_DAYS = 7;

class SessionRecorder {
  /**
   * @param {object} opts
   * @param {string} opts.name        Session name
   * @param {string} [opts.baseDir]   Base directory for recordings (default: .pty-capture under cwd)
   * @param {number} [opts.maxFileSize]  Max file size in bytes before rotation (default: 50MB)
   * @param {number} [opts.retainDays]   Days to retain old recordings (default: 7)
   */
  constructor({ name, baseDir, maxFileSize, retainDays }) {
    this._name = name;
    this._baseDir = baseDir || path.join(process.cwd(), DEFAULT_CAPTURE_DIR);
    this._maxFileSize = maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this._retainDays = retainDays != null ? retainDays : DEFAULT_RETAIN_DAYS;
    this._stream = null;
    this._currentSize = 0;
    this._closed = false;
    this._disabled = false;
  }

  /**
   * Open the recording file stream. Must be called before any write methods.
   * Runs retention cleanup as a side effect.
   */
  open() {
    if (this._disabled || this._closed) return;
    try {
      fs.mkdirSync(this._baseDir, { recursive: true });
      this._cleanup();
      this._openNewFile();
    } catch (err) {
      this._disableWithWarning('open', err);
    }
  }

  writeHeader(config) {
    this._write({
      type: 'header',
      version: 2,
      session: this._name,
      startedAt: Date.now(),
      config,
      cols: config.cols || 80,
      rows: config.rows || 24,
    });
  }

  writeData(data) {
    this._write({ type: 'data', ts: Date.now(), len: data.length, data });
  }

  writeHook(event, payload) {
    this._write({ type: 'hook', ts: Date.now(), event, payload: payload || null });
  }

  writeState(from, to, event, detail) {
    this._write({ type: 'state', ts: Date.now(), from, to, event, detail: detail || null });
  }

  writeInput(data) {
    this._write({ type: 'input', ts: Date.now(), data });
  }

  writeResize(cols, rows) {
    this._write({ type: 'resize', ts: Date.now(), cols, rows });
  }

  writeFooter(reason, exitCode) {
    this._write({ type: 'footer', ts: Date.now(), reason, exitCode: exitCode != null ? exitCode : null });
  }

  /** Idempotent close — safe to call multiple times. */
  close() {
    if (this._closed || !this._stream) {
      this._closed = true;
      return;
    }
    this._closed = true;
    try {
      this._stream.end();
    } catch (err) {
      // Best-effort close
    }
    this._stream = null;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  _write(record) {
    if (this._disabled || this._closed || !this._stream) return;
    try {
      const line = JSON.stringify(record) + '\n';
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
    const filename = `${this._name}-${ts}.jsonl`;
    const filepath = path.join(this._baseDir, filename);
    this._stream = fs.createWriteStream(filepath, { flags: 'a' });
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

  /** Delete recordings older than retainDays. Best-effort, skips locked files. */
  _cleanup() {
    if (this._retainDays <= 0) return;
    const cutoff = Date.now() - (this._retainDays * 24 * 60 * 60 * 1000);
    let entries;
    try {
      entries = fs.readdirSync(this._baseDir);
    } catch {
      return; // Directory may not exist yet
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const filepath = path.join(this._baseDir, entry);
      try {
        const stat = fs.statSync(filepath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filepath);
        }
      } catch {
        // Skip locked or inaccessible files (Windows file handle issue)
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
 * Create a SessionRecorder from a capture config block.
 * Returns null if capture is disabled.
 *
 * @param {string} sessionName
 * @param {object} [captureConfig]  { enabled, maxFileSizeMB, retainDays }
 * @returns {SessionRecorder|null}
 */
function createRecorder(sessionName, captureConfig) {
  const cfg = captureConfig || {};
  if (!cfg.enabled) return null;

  const recorder = new SessionRecorder({
    name: sessionName,
    maxFileSize: cfg.maxFileSizeMB ? cfg.maxFileSizeMB * 1024 * 1024 : undefined,
    retainDays: cfg.retainDays,
  });
  recorder.open();
  return recorder;
}

module.exports = { SessionRecorder, createRecorder };
