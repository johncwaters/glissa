'use strict';

// bench-pipeline.js — Performance benchmark for ANSI tokenizer pipeline
//
// AC5: pipeline.feed() < 3x stripAnsi baseline (p99 ratio)
// Absolute targets in the plan (0.26ms/4KB, 0.84ms/16KB) were derived from
// a specific Linux machine; we use the ratio criterion as primary budget.

const { AnsiTokenizer } = require('../ansi-tokenizer');

// ─── stripAnsi baseline (same regexes as current patterns.js) ─────────────────

const ANSI_REGEXES = [
  /\x1b\[[0-9;]*[mGKHFABCDsuJr]/g,
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,
  /\x1b[()][A-Z0-9]/g,
  /\x1b[=><78NOPQRSTUVWXYZ\\]/g,
  /\x1b[^[\]()=><78NOPQRSTUVWXYZ\\]/g,
  /[\x00-\x08\x0b-\x0c\x0e-\x1a\x1c-\x1f]/g,
];

function stripAnsi(str) {
  let s = str;
  for (const re of ANSI_REGEXES) s = s.replace(re, '');
  return s;
}

// ─── Chunk builder ────────────────────────────────────────────────────────────
// Builds a chunk ending on a complete sequence boundary (no split escapes).
// This avoids measuring partial-sequence GC overhead which is irrelevant to
// the hot-path performance question.

function buildChunk(targetBytes) {
  const parts = [];
  let total = 0;
  while (total < targetBytes) {
    parts.push('hello world testing output data '); total += 32;
    parts.push('\x1b[1;33m');                       total += 7;
    parts.push('\x1b[0m');                          total += 4;
    parts.push('\r\n');                             total += 2;
    parts.push('\x1b[K');                           total += 3;
    parts.push('\x1b]0;title\x07');                 total += 11;
  }
  return parts.join('').slice(0, targetBytes);
}

// ─── Benchmark runner ─────────────────────────────────────────────────────────

function bench(label, fn, chunk, N) {
  // Extended warmup — give JIT time to compile hot paths
  for (let i = 0; i < 300; i++) fn(chunk);

  const times = [];
  for (let i = 0; i < N; i++) {
    const start = process.hrtime.bigint();
    fn(chunk);
    const end = process.hrtime.bigint();
    times.push(Number(end - start) / 1e6); // ns → ms
  }

  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(N * 0.50)];
  const p99 = times[Math.floor(N * 0.99)];
  const max = times[N - 1];

  console.log(`  ${label.padEnd(32)} p50=${p50.toFixed(3)}ms  p99=${p99.toFixed(3)}ms  max=${max.toFixed(3)}ms`);
  return { p50, p99, max };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const N = 1000;

console.log('\nBuilding benchmark chunks...');
const chunk4k  = buildChunk(4096);
const chunk16k = buildChunk(16384);
console.log(`  4KB chunk:  ${chunk4k.length} bytes`);
console.log(`  16KB chunk: ${chunk16k.length} bytes`);

// Use a shared stateful tokenizer — matches production use (one per session)
const tok4k  = new AnsiTokenizer();
const tok16k = new AnsiTokenizer();

console.log(`\n4KB chunks (${N} iterations, stateful tokenizer):`);
const strip4k = bench('stripAnsi (baseline)', (c) => stripAnsi(c), chunk4k, N);
const ansi4k  = bench('AnsiTokenizer',        (c) => tok4k.tokenize(c), chunk4k, N);

console.log(`\n16KB chunks (${N} iterations, stateful tokenizer):`);
const strip16k = bench('stripAnsi (baseline)', (c) => stripAnsi(c), chunk16k, N);
const ansi16k  = bench('AnsiTokenizer',        (c) => tok16k.tokenize(c), chunk16k, N);

// ─── Budget check ─────────────────────────────────────────────────────────────
//
// AC5 primary criterion: < 3x stripAnsi p99 baseline
// Absolute targets from plan (0.26ms / 0.84ms) shown as reference — they were
// measured on a specific machine where stripAnsi 4KB p99 ≈ 0.085ms.
// On this machine stripAnsi p99 is higher; ratio is the machine-independent check.

const RATIO_BUDGET = 3.0;
const ABS_4K  = 0.26;
const ABS_16K = 0.84;

const ratio4k  = ansi4k.p99  / strip4k.p99;
const ratio16k = ansi16k.p99 / strip16k.p99;

const ok4k  = ratio4k  <= RATIO_BUDGET;
const ok16k = ratio16k <= RATIO_BUDGET;

console.log('\nBudget check (AC5: AnsiTokenizer p99 < 3x stripAnsi p99):');
console.log(`  4KB  ${ratio4k.toFixed(2)}x baseline  (budget: ${RATIO_BUDGET}x)  abs=${ansi4k.p99.toFixed(3)}ms  ref=${ABS_4K}ms  — ${ok4k ? 'PASS' : 'FAIL'}`);
console.log(`  16KB ${ratio16k.toFixed(2)}x baseline  (budget: ${RATIO_BUDGET}x)  abs=${ansi16k.p99.toFixed(3)}ms  ref=${ABS_16K}ms  — ${ok16k ? 'PASS' : 'FAIL'}`);

if (!ok4k || !ok16k) {
  console.error('\nPERFORMANCE BUDGET EXCEEDED');
  process.exit(1);
} else {
  console.log('\nAll benchmarks within budget.');
}
