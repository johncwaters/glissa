'use strict';

// Replay harness, driving recorded sessions (session-recorder JSONL) through the
// real detection pipeline (OscTitleSource + StatusSource + hook mapping) so the
// engine's reliability is measurable against ground truth. Version-aware:
//   v1: data records only (legacy; exercises the title fallback).
//   v2: data + hook records (exercises the authoritative path too), interleaved by ts.

const { setTimeout: sleep } = require('node:timers/promises');
const { createOscTitleSource } = require('./osc-title-source');
const { createStatusSource } = require('./status-source');
const { resolveAdapter } = require('../session/adapters');

// Parse a JSONL recording into { version, agent, records } with records sorted by ts. `agent` is the
// header field the recorder stamps (M2); a recording made before it, or by the default agent, replays
// through the Claude Code adapter exactly as it always did.
function parseRecording(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let version = 1;
  let agent = null;
  const records = [];
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // tolerate a truncated trailing line
    }
    if (rec.type === 'header') {
      version = rec.version || 1;
      agent = rec.agent || null;
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
async function replayDetection(records, opts = {}) {
  const stabilizationMs = opts.stabilizationMs ?? 1500;
  const conflictWindowMs = opts.conflictWindowMs ?? 750;
  const dedupWindowMs = opts.dedupWindowMs ?? 500;
  const adapter = resolveAdapter(opts.agent ?? null);

  const title = createOscTitleSource({ stabilizationMs, titleProfile: adapter.titleProfile });
  // What the live session's title source is told at spawn (codex reads its idle title by comparing it
  // against the cwd basename), so a fixture is judged by the same rule rather than an easier one.
  if (opts.titleContext) title.setContext(opts.titleContext);
  const status = createStatusSource({ sessionId: 'replay', conflictWindowMs, dedupWindowMs });
  const signals = [];
  const meta = [];
  title.on('signal', (s) => status.ingest(s));
  status.on('status', (s) => signals.push(s));
  status.on('meta', (m) => meta.push(m));

  for (const r of records) {
    if (r.type === 'data' && typeof r.data === 'string') {
      title.feed(r.data);
    }
    if (r.type === 'hook') {
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
function summarize(signals) {
  const counts = {};
  for (const s of signals) counts[s.signal] = (counts[s.signal] || 0) + 1;
  return counts;
}

module.exports = { parseRecording, replayDetection, summarize };
