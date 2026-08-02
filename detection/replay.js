'use strict';

// Replay harness — drives recorded sessions (session-recorder JSONL) through the
// real detection pipeline (OscTitleSource + StatusSource + hook mapping) so the
// engine's reliability is measurable against ground truth. Version-aware:
//   v1 — data records only (legacy; exercises the title fallback).
//   v2 — data + hook records (exercises the authoritative path too), interleaved by ts.

const { setTimeout: sleep } = require('node:timers/promises');
const { createOscTitleSource } = require('./osc-title-source');
const { createStatusSource } = require('./status-source');
const { mapHookToSignal } = require('./hook-source');

// Parse a JSONL recording into { version, records } with records sorted by ts.
function parseRecording(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let version = 1;
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
      continue;
    }
    records.push(rec);
  }
  records.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return { version, records };
}

// Replay records through the detection pipeline. Records are fed in ts order;
// timers (title stabilization, conflict window) run in real time, then we settle.
// Returns { signals, meta } where signals are the resolved StatusSource emissions.
async function replayDetection(records, opts = {}) {
  const stabilizationMs = opts.stabilizationMs ?? 1500;
  const conflictWindowMs = opts.conflictWindowMs ?? 750;
  const dedupWindowMs = opts.dedupWindowMs ?? 500;

  const title = createOscTitleSource({ stabilizationMs });
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
      const sig = mapHookToSignal(r.event, r.payload);
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
