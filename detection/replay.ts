// Replay harness, driving recorded sessions (session-recorder JSONL) through the
// real detection pipeline (OscTitleSource + StatusSource + hook mapping) so the
// engine's reliability is measurable against ground truth. Version-aware:
//   v1: data records only (legacy; exercises the title fallback).
//   v2: data + hook records (exercises the authoritative path too), interleaved by ts.

import { setTimeout as sleep } from 'node:timers/promises';

import { createOscTitleSource } from './osc-title-source.ts';
import type { TitleContext } from './osc-title-source.ts';
import { createStatusSource } from './status-source.ts';
import type { MetaStatusSignal, ResolvedStatusSignal } from './status-source.ts';
import { resolveAdapter } from '../session/adapters/index.ts';
import type { HookPayload } from '../shared/contracts/index.ts';

export interface ReplayRecord {
  type?: string;
  ts?: number;
  data?: string;
  event?: string;
  payload?: HookPayload;
  [key: string]: unknown;
}

export interface ReplayOptions {
  stabilizationMs?: number;
  conflictWindowMs?: number;
  dedupWindowMs?: number;
  agent?: string | null;
  titleContext?: TitleContext;
}

// Parse a JSONL recording into { version, agent, records } with records sorted by ts. `agent` is the
// header field the recorder stamps (M2); a recording made before it, or by the default agent, replays
// through the Claude Code adapter exactly as it always did.
function parseRecording(text: string): { version: number; agent: string | null; records: ReplayRecord[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let version = 1;
  let agent: string | null = null;
  const records: ReplayRecord[] = [];
  for (const line of lines) {
    let rec: ReplayRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // tolerate a truncated trailing line
    }
    if (rec.type === 'header') {
      version = typeof rec.version === 'number' ? rec.version : 1;
      agent = typeof rec.agent === 'string' ? rec.agent : null;
      continue;
    }
    records.push(rec);
  }
  records.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return { version, agent, records };
}

// Replay records through the detection pipeline. Records are fed in ts order;
// timers (title stabilization, conflict window) run in real time, then we settle.
// Returns { signals, meta } where signals are the resolved StatusSource emissions.
// `agent` selects the adapter whose title profile and hook vocabulary the replay reads with, so a
// codex recording is judged by codex's rules rather than Claude Code's (absent = the default agent);
// `titleContext` supplies what that profile needs about the recorded session (its cwd basename).
async function replayDetection(records: ReplayRecord[], opts: ReplayOptions = {}) {
  const stabilizationMs = opts.stabilizationMs ?? 1500;
  const conflictWindowMs = opts.conflictWindowMs ?? 750;
  const dedupWindowMs = opts.dedupWindowMs ?? 500;
  const adapter = resolveAdapter(opts.agent ?? null);
  if (!adapter) throw new Error(`unknown agent adapter: ${opts.agent}`);

  const title = createOscTitleSource({ stabilizationMs, titleProfile: adapter.titleProfile });
  // What the live session's title source is told at spawn (codex reads its idle title by comparing it
  // against the cwd basename), so a fixture is judged by the same rule rather than an easier one.
  if (opts.titleContext) title.setContext(opts.titleContext);
  const status = createStatusSource({ sessionId: 'replay', conflictWindowMs, dedupWindowMs });
  const signals: ResolvedStatusSignal[] = [];
  const meta: MetaStatusSignal[] = [];
  title.on('signal', (s) => status.ingest(s));
  status.on('status', (s) => signals.push(s));
  status.on('meta', (m) => meta.push(m));

  for (const r of records) {
    if (r.type === 'data' && typeof r.data === 'string') {
      title.feed(r.data);
    }
    if (r.type === 'hook' && typeof r.event === 'string') {
      const sig = adapter.hooks.mapSignal(r.event, r.payload);
      if (sig) {
        status.ingest({ signal: sig, source: 'hook', ts: Date.now(), event: r.event, payload: r.payload });
      }
    }
  }

  await sleep(stabilizationMs + conflictWindowMs + 60);
  title.destroy();
  status.destroy();
  return { signals, meta };
}

// Convenience: count resolved signals by type.
function summarize(signals: { signal: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of signals) counts[s.signal] = (counts[s.signal] || 0) + 1;
  return counts;
}

export { parseRecording, replayDetection, summarize };
