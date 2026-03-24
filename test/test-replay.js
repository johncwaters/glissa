'use strict';

/**
 * Replay-based regression tests for PatternDetector.
 *
 * Uses node:test mock timers to simulate real timing deltas from JSONL
 * recordings. This is a separate testing pattern from test-patterns.js
 * (which uses real wall-clock delays for unit tests).
 *
 * Workflow to add a new regression test:
 *   1. Enable capture: set config.json capture.enabled = true
 *   2. Reproduce the issue (false positive or missed detection)
 *   3. Copy the recording from .pty-capture/ to test/fixtures/
 *   4. Run: node --test test/test-replay.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { replay } = require('./replay-harness');

const FIXTURES = path.join(__dirname, 'fixtures');

describe('Replay: true-positive.jsonl', () => {
  it('detects a genuine (y/n) prompt via Layer 1', (t) => {
    const result = replay(t, path.join(FIXTURES, 'true-positive.jsonl'));

    assert.ok(result.detections.length >= 1, 'should detect at least 1 prompt');
    assert.equal(result.detections[0].layer, 1, 'should be Layer 1 detection');
    assert.ok(result.detections[0].line.includes('Do you want to proceed?'), 'line should contain prompt text');
    assert.equal(result.falsePositives.length, 0, 'no false positives');
    assert.equal(result.missedDetections.length, 0, 'no missed detections');
  });
});

describe('Replay: false-positive-conversational.jsonl', () => {
  it('does NOT detect conversational AI output as a prompt', (t) => {
    const result = replay(t, path.join(FIXTURES, 'false-positive-conversational.jsonl'));

    assert.equal(result.detections.length, 0,
      'should produce zero detections for conversational output');
    assert.equal(result.detectionRecords.length, 0,
      'recording has no detection records (ground truth)');
  });
});

describe('Replay: layer3-colon-prompt.jsonl', () => {
  it('detects a colon-ending input prompt via Layer 3', (t) => {
    const result = replay(t, path.join(FIXTURES, 'layer3-colon-prompt.jsonl'));

    assert.ok(result.detections.length >= 1, 'should detect at least 1 prompt');
    assert.equal(result.detections[0].layer, 3, 'should be Layer 3 detection');
    assert.equal(result.detections[0].pattern, 'silence_heuristic');
    assert.ok(result.detections[0].line.includes('API key:'), 'line should contain the prompt');
    assert.equal(result.falsePositives.length, 0, 'no false positives');
    assert.equal(result.missedDetections.length, 0, 'no missed detections');
  });
});
