
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WriteStream } from "node:fs";

import { glimmervoidHomeDir } from "../server/core/config-path-core.ts";
import { safePathSegment } from "../shared/paths.ts";
import type { DecisionEntry } from "./core/decision-log.ts";
import type { SessionState } from "../shared/states.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import { projectHookPayload } from "./core/hook-payload-projection.ts";

function defaultRecordingsDir(): string {
  return path.join(glimmervoidHomeDir(os.homedir(), process.env), "recordings");
}

const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;
const DEFAULT_RETAIN_DAYS = 7;
const DEFAULT_RETAIN_FILES = 20;
const DEFAULT_RETAIN_BYTES = 64 * 1024 * 1024;

const openRecordingPaths = new Set<string>();

let pendingCleanups: Promise<void> = Promise.resolve();

function afterPendingCleanups(runCleanup: () => Promise<void>): Promise<void> {
  const thisCleanup = pendingCleanups.then(runCleanup, runCleanup);
  pendingCleanups = thisCleanup.then(() => undefined, () => undefined);
  return thisCleanup;
}

function resolveRetainBytes(requestedRetainBytes: number | undefined, resolvedRetainDays: number, resolvedRetainFiles: number): number {
  if (requestedRetainBytes != null) return requestedRetainBytes;
  if (resolvedRetainDays <= 0 && resolvedRetainFiles <= 0) return 0;
  return DEFAULT_RETAIN_BYTES;
}

interface SessionRecorderOptions {
  name: string;
  baseDir?: string;
  recordData?: boolean;
  maxFileSize?: number;
  retainDays?: number;
  retainFiles?: number;
  retainBytes?: number;
}

interface CaptureConfig {
  enabled?: boolean;
  baseDir?: string;
  maxFileSizeMB?: number;
  retainDays?: number;
  retainFiles?: number;
  retainBytes?: number;
}

class SessionRecorder {
  _name: string;
  _safeName: string;
  _baseDir: string;
  _recordData: boolean;
  _maxFileSize: number;
  _retainDays: number;
  _retainFiles: number;
  _retainBytes: number;
  _stream: WriteStream | null;
  _filepath: string | null;
  _currentSize: number;
  _opened: boolean;
  _closed: boolean;
  _disabled: boolean;
  retentionDone: Promise<void>;

  constructor({ name, baseDir, recordData = false, maxFileSize, retainDays, retainFiles, retainBytes }: SessionRecorderOptions) {
    this._name = name;
    this._safeName = safePathSegment(name);
    this._baseDir = baseDir || defaultRecordingsDir();
    this._recordData = !!recordData;
    this._maxFileSize = maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this._retainDays = retainDays != null ? retainDays : DEFAULT_RETAIN_DAYS;
    this._retainFiles = retainFiles != null ? retainFiles : DEFAULT_RETAIN_FILES;
    this._retainBytes = resolveRetainBytes(retainBytes, this._retainDays, this._retainFiles);
    this._stream = null;
    this._filepath = null;
    this._currentSize = 0;
    this._opened = false;
    this._closed = false;
    this._disabled = false;
    this.retentionDone = Promise.resolve();
  }

  get recordsData(): boolean {
    return this._recordData;
  }

  open(): void {
    if (this._disabled || this._closed || this._opened) return;
    this._opened = true;
    try {
      fs.mkdirSync(this._baseDir, { recursive: true });
      this._openNewFile();
      this.retentionDone = afterPendingCleanups(() => this._cleanup());
    } catch (err) {
      this._disableWithWarning("open", err);
    }
  }

  writeHeader(config: { agent?: string | null; cols?: number; rows?: number } & Record<string, unknown> = {}): void {
    const { agent = null, ...rest } = config;
    this._write({
      type: "header",
      version: 2,
      records: this._recordData ? "full" : "signals",
      session: this._name,
      agent,
      startedAt: Date.now(),
      config: rest,
      cols: rest.cols || 80,
      rows: rest.rows || 24,
    });
  }

  writeData(data: string): void {
    if (!this._recordData) return;
    this._write({ type: "data", ts: Date.now(), len: data.length, data });
  }

  writeHook(event: string, payload: HookPayload | null | undefined): void {
    this._write({ type: "hook", ts: Date.now(), event, payload: projectHookPayload(payload) });
  }

  writeState(from: SessionState, to: SessionState, event: string, detail: unknown): void {
    this._write({ type: "state", ts: Date.now(), from, to, event, detail: detail || null });
  }

  writeDecision(entry: DecisionEntry | null | undefined): void {
    const e = entry || {};
    this._write({ type: "decision", ts: e.ts || Date.now(), ...e });
  }

  writeInput(data: string): void {
    if (!this._recordData) return;
    this._write({ type: "input", ts: Date.now(), data });
  }

  writeResize(cols: number, rows: number): void {
    if (!this._recordData) return;
    this._write({ type: "resize", ts: Date.now(), cols, rows });
  }

  writeFooter(reason: string, exitCode: number | null | undefined): void {
    const record = { type: "footer", ts: Date.now(), reason, exitCode: exitCode != null ? exitCode : null };
    this._write(record);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._releaseOpenPath();
    if (!this._stream) return;
    try {
      this._stream.end();
    } catch {
    }
    this._stream = null;
  }


  _write(record: Record<string, unknown>): void {
    if (this._disabled || this._closed) return;
    if (!this._opened) this.open();
    if (!this._stream) return;
    try {
      const line = `${JSON.stringify(record)}\n`;
      this._stream.write(line);
      this._currentSize += Buffer.byteLength(line, "utf8");

      if (this._currentSize >= this._maxFileSize) {
        this._rotate();
      }
    } catch (err) {
      this._disableWithWarning("write", err);
    }
  }

  _releaseOpenPath(): void {
    if (!this._filepath) return;
    openRecordingPaths.delete(this._filepath);
  }

  _openNewFile(): void {
    this._releaseOpenPath();
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this._filepath = path.join(this._baseDir, `${this._safeName}-${ts}.jsonl`);
    openRecordingPaths.add(this._filepath);
    this._stream = fs.createWriteStream(this._filepath, { flags: "a" });
    this._currentSize = 0;

    this._stream.on("error", (err) => {
      this._disableWithWarning("stream", err);
    });
  }

  _rotate(): void {
    try {
      if (this._stream) {
        this._stream.end();
      }
      this._openNewFile();
    } catch (err) {
      this._disableWithWarning("rotate", err);
    }
  }

  async _cleanup(): Promise<void> {
    if (this._retainDays <= 0 && this._retainFiles <= 0 && this._retainBytes <= 0) return;
    let entries: string[];
    try {
      entries = await fsp.readdir(this._baseDir);
    } catch {
      return;
    }
    const recordings = entries.filter((e) => e.endsWith(".jsonl"));
    const doomed = new Set<string>();

    if (this._retainFiles > 0) {
      const mine = recordings.filter((e) => e.startsWith(`${this._safeName}-`));
      const current = this._filepath ? path.basename(this._filepath) : null;
      if (current && !mine.includes(current)) mine.push(current);
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
        }
      }
    }

    for (const entry of doomed) {
      const filepath = path.join(this._baseDir, entry);
      if (filepath === this._filepath || openRecordingPaths.has(filepath)) continue;
      try {
        await fsp.unlink(filepath);
      } catch {
      }
    }
    if (this._retainBytes <= 0) return;
    const current = this._filepath ? path.basename(this._filepath) : null;
    const measured = (await Promise.all(recordings
      .filter((entry) => !doomed.has(entry) && entry !== current)
      .map(async (entry) => {
        try {
          const stat = await fsp.stat(path.join(this._baseDir, entry));
          return { entry, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      }))).filter((entry): entry is { entry: string; size: number; mtimeMs: number } => entry !== null);
    const liveSize = current ? this._currentSize : 0;
    let totalBytes = liveSize + measured.reduce((total, entry) => total + entry.size, 0);
    const evictable = measured
      .filter((entry) => !openRecordingPaths.has(path.join(this._baseDir, entry.entry)))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of evictable) {
      if (totalBytes <= this._retainBytes) return;
      try {
        await fsp.unlink(path.join(this._baseDir, entry.entry));
        totalBytes -= entry.size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") totalBytes -= entry.size;
      }
    }
  }

  _disableWithWarning(context: string, err: unknown): void {
    if (this._disabled) return;
    this._disabled = true;
    console.warn(`[session-recorder:${this._name}] Recording disabled (${context}): ${err instanceof Error ? err.message : String(err)}`);
    this._releaseOpenPath();
    if (this._stream) {
      try { this._stream.end(); } catch {  }
      this._stream = null;
    }
  }
}

function createRecorder(
  sessionName: string,
  captureConfig?: CaptureConfig | null,
  recordSignals = true,
): SessionRecorder | null {
  const cfg = captureConfig || {};
  const recordData = !!cfg.enabled;
  if (!recordData && !recordSignals) return null;

  return new SessionRecorder({
    name: sessionName,
    baseDir: cfg.baseDir,
    recordData,
    maxFileSize: cfg.maxFileSizeMB ? cfg.maxFileSizeMB * 1024 * 1024 : undefined,
    retainDays: cfg.retainDays,
    retainFiles: cfg.retainFiles,
    retainBytes: cfg.retainBytes,
  });
}

export { SessionRecorder, createRecorder, defaultRecordingsDir };
export type { CaptureConfig, SessionRecorderOptions };
