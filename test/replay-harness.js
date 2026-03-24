'use strict';

/**
 * Replay Harness — reads a JSONL recording and drives it through a fresh
 * PatternDetector with simulated time via node:test mock timers.
 *
 * Replay Algorithm:
 *   1. Enable mock.timers for setTimeout/clearTimeout
 *   2. Parse header to reconstruct PatternDetector with matching config
 *   3. For each data record at index i:
 *      a. Compute delta = record[i].ts - record[i-1].ts (0 for first)
 *      b. Call mock.timers.tick(delta) to advance simulated time
 *      c. Call detector.feed(record[i].data)
 *   4. For each input record: call detector.reset()
 *   5. After last record: tick by max(silenceTimeoutMs, confirmationMs) to flush
 *   6. Restore real timers
 *
 * "Instant replay" means simulated time with real deltas — no wall-clock delays.
 */

const fs = require('node:fs');
const { PatternDetector } = require('../patterns');

/**
 * Parse a JSONL recording file into an array of record objects.
 * @param {string} filepath  Path to the .jsonl file
 * @returns {{ header: object, records: object[] }}
 */
function parseRecording(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const parsed = lines.map(l => JSON.parse(l));

  const header = parsed.find(r => r.type === 'header');
  if (!header) throw new Error(`No header record found in ${filepath}`);

  const records = parsed.filter(r => r.type !== 'header');
  return { header, records };
}

/**
 * Replay a recording through PatternDetector using mock timers.
 *
 * @param {object} ctx              node:test context (for mock.timers)
 * @param {string} filepath         Path to .jsonl recording
 * @param {object} [opts]
 * @param {number} [opts.expectedDetections]  Expected number of detections (for assertion)
 * @returns {{ detections: object[], detectionRecords: object[], stateRecords: object[], falsePositives: object[], missedDetections: object[] }}
 */
function replay(ctx, filepath, opts = {}) {
  const { header, records } = parseRecording(filepath);
  const config = header.config || {};

  // Reconstruct detector with recorded config
  const silenceTimeoutMs = config.promptDetectionMs || 1500;
  const confirmationMs = config.confirmationMs || 300;
  const detector = new PatternDetector(silenceTimeoutMs, confirmationMs);

  // Collect detections emitted by the detector during replay
  const detections = [];
  detector.on('prompt-detected', (det) => {
    detections.push({ ...det, ts: Date.now() });
  });

  // Enable mock timers
  ctx.mock.timers.enable({ apis: ['setTimeout'] });

  let lastTs = null;

  // Extract ground truth from recording
  const detectionRecords = records.filter(r => r.type === 'detection');
  const stateRecords = records.filter(r => r.type === 'state');

  // Replay data and input records in order
  for (const record of records) {
    if (record.type === 'data') {
      // Advance simulated time by delta
      if (lastTs !== null) {
        const delta = Math.max(0, record.ts - lastTs);
        if (delta > 0) ctx.mock.timers.tick(delta);
      }
      lastTs = record.ts;
      detector.feed(record.data);

    } else if (record.type === 'input') {
      if (lastTs !== null) {
        const delta = Math.max(0, record.ts - lastTs);
        if (delta > 0) ctx.mock.timers.tick(delta);
      }
      lastTs = record.ts;
      detector.reset(); // User responded

    } else if (record.type === 'resize') {
      // No-op for detector, just advance time
      if (lastTs !== null) {
        const delta = Math.max(0, record.ts - lastTs);
        if (delta > 0) ctx.mock.timers.tick(delta);
      }
      lastTs = record.ts;
    }
    // state, detection, footer records are ground truth — don't replay
  }

  // Flush any pending timers (confirmation or silence)
  const flushMs = Math.max(silenceTimeoutMs, confirmationMs) + 100;
  ctx.mock.timers.tick(flushMs);

  // Classify results
  // A false positive is a detection that doesn't correspond to any detection record in the capture
  const falsePositives = [];
  const matchedDetections = new Set();

  for (const det of detections) {
    const match = detectionRecords.find((dr, i) =>
      !matchedDetections.has(i) && dr.layer === det.layer && dr.pattern === det.pattern
    );
    if (match) {
      matchedDetections.add(detectionRecords.indexOf(match));
    } else {
      falsePositives.push(det);
    }
  }

  // Missed detections: detection records not matched by replay
  const missedDetections = detectionRecords.filter((_, i) => !matchedDetections.has(i));

  return {
    detections,
    detectionRecords,
    stateRecords,
    falsePositives,
    missedDetections,
  };
}

module.exports = { replay, parseRecording };
