'use strict';

/*
 * The pure decisions behind M14 transcript ingestion (docs/plan-visions-3.md): which mapped agent-log
 * event becomes which durable record, what a per-tick batch is, and where a resumed read starts.
 *
 * The load-bearing rules here are the trust stamp (nothing ingested may exceed `reported`), the
 * user-prompt tag that keeps operator text out of knowledge and preference records, and the mismatch
 * rule on the durable offsets: anything that does not still describe a prefix of the file restarts at
 * end of file rather than replaying a rotated history.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideResumeRead, enqueueIngestInput, memoryInputFromEvent, normalizeTailState, planBackfillRead,
  planIngestBatch, recordTailOffset, tailStateForget,
} = require('../server/core/memory-ingest-core');
const { PROMPT_KIND } = require('../server/core/ingest-agent-core');
const {
  DEFAULT_MEMORY_RETAIN_DAYS, buildMemoryRecord, clampObservedTs, hashMemoryLine, segmentKeyForTs,
} = require('../server/core/memory-core');

function event(overrides = {}) {
  return {
    source: 'agentLogs',
    kind: 'agent-turn',
    ts: 1766400000000,
    scope: { root: 'C:\\repo', sessionId: 'sess-1' },
    summary: 'claude: rewired the spawn gate',
    detail: { vendor: 'claude' },
    ...overrides,
  };
}

// --- Mapping --------------------------------------------------------------

test('an assistant turn becomes an episodic knowledge record stamped reported', () => {
  const input = memoryInputFromEvent(event());
  assert.equal(input.kind, 'knowledge');
  assert.equal(input.layer, 'episodic');
  assert.equal(input.source.kind, 'reported');
  assert.equal(input.source.vendor, 'claude');
  assert.equal(input.source.sessionId, 'sess-1');
  assert.equal(input.project, 'C:\\repo');
  assert.equal(input.fromUserPrompt, false);
});

test('the ingest mapper stamps a known project before the record reaches storage', () => {
  const projectPath = 'C:\\Work\\Glissa';
  const input = memoryInputFromEvent(event({
    scope: { root: 'C:\\Work\\.glissa-worktrees\\Glissa-abc123', sessionId: 'sess-1' },
  }), { knownProjects: [{ path: projectPath }] });
  assert.equal(input.project, 'c:/work/glissa');
});

test('a tool call is knowledge too, and its ts rides the event', () => {
  const input = memoryInputFromEvent(event({ kind: 'agent-tool', summary: 'claude: Read a.js', ts: 42 }));
  assert.equal(input.kind, 'knowledge');
  assert.equal(input.ts, 42);
});

test('a user prompt becomes a prompt record tagged so the knowledge gate applies', () => {
  const input = memoryInputFromEvent(event({ kind: PROMPT_KIND, summary: 'claude prompt: ship M14' }));
  assert.equal(input.kind, 'prompt');
  assert.equal(input.layer, 'episodic');
  assert.equal(input.fromUserPrompt, true);
});

test('the trust stamp comes from the write path, never from the event', () => {
  const input = memoryInputFromEvent(event({
    source: 'agentLogs', detail: { vendor: 'claude', kind: 'operator' }, sourceKind: 'operator',
  }));
  assert.equal(input.source.kind, 'reported');
});

test('an event with no project root is dropped, the same rule the ring applies', () => {
  assert.equal(memoryInputFromEvent(event({ scope: { root: null, sessionId: 'sess-1' } })), null);
});

test('an event from another source or of an unmapped kind is never remembered', () => {
  assert.equal(memoryInputFromEvent(event({ source: 'terminal', kind: 'output' })), null);
  assert.equal(memoryInputFromEvent(event({ kind: 'agent-thought' })), null);
});

test('an unknown vendor is refused rather than guessed at', () => {
  assert.equal(memoryInputFromEvent(event({ detail: { vendor: 'llama' } })), null);
});

test('a line the store already delivered is dropped, so a quoted memory is not re-ingested', () => {
  const delivered = new Set([hashMemoryLine('claude: rewired the spawn gate')]);
  assert.equal(memoryInputFromEvent(event(), { deliveredHashes: delivered }), null);
});

test('echo suppression drops only the echoed lines, keeping what is new', () => {
  const delivered = new Set([hashMemoryLine('quoted from memory')]);
  const input = memoryInputFromEvent(
    event({ summary: 'quoted from memory\nand something new' }),
    { deliveredHashes: delivered },
  );
  assert.equal(input.text, 'and something new');
});

test('the ingested input is refused as knowledge when it carries the user-prompt tag', () => {
  const built = buildMemoryRecord({
    kind: 'knowledge',
    source: { kind: 'reported', vendor: 'claude', sessionId: null },
    text: 'my api key is in the vault',
    fromUserPrompt: true,
  }, { now: 1766400000000 });
  assert.equal(built.ok, false);
  assert.equal(built.reason, 'user-prompt-kind');
});

test('the same tag is refused for preference and allowed for prompt', () => {
  const base = {
    source: { kind: 'reported', vendor: 'claude', sessionId: null },
    text: 'always run the suite first',
    fromUserPrompt: true,
  };
  assert.equal(buildMemoryRecord({ ...base, kind: 'preference' }, { now: 1 }).ok, false);
  assert.equal(buildMemoryRecord({ ...base, kind: 'prompt' }, { now: 1 }).ok, true);
});

test('an observed ts derives a stable id, which is what makes a re-ingest idempotent', () => {
  const input = { ...memoryInputFromEvent(event()), ts: 1766400000000 };
  const first = buildMemoryRecord(input, { now: 1766499999999 });
  const second = buildMemoryRecord(input, { now: 1766599999999 });
  assert.equal(first.record.ts, 1766400000000);
  assert.equal(first.record.id, second.record.id);
});

// --- Batching -------------------------------------------------------------

test('a batch takes at most the per-tick cap and leaves the rest queued', () => {
  const queued = [1, 2, 3, 4, 5];
  const batch = planIngestBatch(queued, { maxPerTick: 2 });
  assert.deepEqual(batch.take, [1, 2]);
  assert.deepEqual(batch.rest, [3, 4, 5]);
});

test('the queue is bounded oldest-first, and reports what it dropped', () => {
  let queue = [];
  let dropped = 0;
  for (const value of [1, 2, 3, 4]) {
    const outcome = enqueueIngestInput(queue, value, { maxQueued: 2 });
    queue = outcome.queue;
    dropped += outcome.dropped;
  }
  assert.deepEqual(queue, [3, 4]);
  assert.equal(dropped, 2);
});

// --- Durable offsets ------------------------------------------------------

test('a recorded offset round-trips through normalization', () => {
  const state = recordTailOffset(null, {
    path: '/t/a.jsonl', size: 400, mtimeMs: 90, offset: 400, ts: 5,
  });
  const reloaded = normalizeTailState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(reloaded.files['/t/a.jsonl'], {
    size: 400, mtimeMs: 90, offset: 400, ts: 5,
  });
});

test('a malformed entry is dropped on load rather than trusted', () => {
  const reloaded = normalizeTailState({ files: { '/t/a.jsonl': { size: 'huge' }, '/t/b.jsonl': null } });
  assert.deepEqual(reloaded.files, {});
});

test('the tail state is bounded, forgetting whatever stopped moving first', () => {
  let state = null;
  for (const index of [1, 2, 3]) {
    state = recordTailOffset(state, {
      path: `/t/${index}.jsonl`, size: 10, mtimeMs: 1, offset: 10, ts: index,
    }, { maxEntries: 2 });
  }
  assert.deepEqual(Object.keys(state.files).sort(), ['/t/2.jsonl', '/t/3.jsonl']);
});

test('a file that vanished is forgotten explicitly', () => {
  const state = recordTailOffset(null, { path: '/t/a.jsonl', size: 1, mtimeMs: 1, offset: 1, ts: 1 });
  assert.deepEqual(tailStateForget(state, ['/t/a.jsonl']).files, {});
});

test('an unknown file is a cold start from the top, which is what a backfill is for', () => {
  const decision = decideResumeRead(undefined, { size: 900, mtimeMs: 10 });
  assert.equal(decision.action, 'cold');
  assert.equal(decision.start, 0);
});

test('a grown file resumes from the recorded offset', () => {
  const recorded = { size: 400, mtimeMs: 10, offset: 400, ts: 1 };
  const decision = decideResumeRead(recorded, { size: 900, mtimeMs: 20 });
  assert.equal(decision.action, 'resume');
  assert.equal(decision.start, 400);
});

test('a file that shrank is a mismatch, so it restarts at end of file', () => {
  const recorded = { size: 400, mtimeMs: 10, offset: 400, ts: 1 };
  const decision = decideResumeRead(recorded, { size: 120, mtimeMs: 20 });
  assert.equal(decision.action, 'restart');
  assert.equal(decision.start, 120);
  assert.equal(decision.reason, 'shrank');
});

test('an mtime that went backwards is a mismatch too', () => {
  const recorded = { size: 400, mtimeMs: 90, offset: 400, ts: 1 };
  const decision = decideResumeRead(recorded, { size: 900, mtimeMs: 10 });
  assert.equal(decision.action, 'restart');
  assert.equal(decision.reason, 'rewound');
});

test('a file that has not moved is current and reads nothing', () => {
  const recorded = { size: 400, mtimeMs: 10, offset: 400, ts: 1 };
  assert.equal(decideResumeRead(recorded, { size: 400, mtimeMs: 10 }).action, 'current');
});

test('a read is bounded by the budget and reports the rest as partial', () => {
  const plan = planBackfillRead({ start: 0, size: 5000, budgetBytes: 1000, maxChunkBytes: 4096 });
  assert.deepEqual(plan, { action: 'read', start: 0, end: 1000, partial: true });
});

test('a read inside the budget finishes the file', () => {
  const plan = planBackfillRead({ start: 100, size: 600, budgetBytes: 1000, maxChunkBytes: 4096 });
  assert.deepEqual(plan, { action: 'read', start: 100, end: 600, partial: false });
});

test('an exhausted budget reads nothing and stays partial', () => {
  const plan = planBackfillRead({ start: 0, size: 500, budgetBytes: 0, maxChunkBytes: 4096 });
  assert.equal(plan.action, 'skip');
  assert.equal(plan.partial, true);
});

// --- The observed ts is untrusted input -----------------------------------

/*
 * A transcript line supplies its own timestamp, and that field decides which monthly segment a record
 * lands in. A future-dated one lands in a segment expiredSegmentKeys can never prune and heads every
 * recency ranking forever, so the window is the gate.
 */
const NOW = 1766400000000;
const DAY = 86400000;

test('an in-window observed ts is kept exactly, so the ordinary record is unchanged', () => {
  assert.equal(clampObservedTs(NOW - 3 * DAY, { now: NOW }), NOW - 3 * DAY);
  assert.equal(clampObservedTs(NOW, { now: NOW }), NOW);
});

test('a future-dated ts falls back to the clock rather than outrunning retention', () => {
  assert.equal(clampObservedTs(NOW + 400 * DAY, { now: NOW }), NOW);
  assert.equal(clampObservedTs(Number.MAX_SAFE_INTEGER, { now: NOW }), NOW);
});

test('a small forward skew is tolerated, because two machines never agree exactly', () => {
  assert.equal(clampObservedTs(NOW + 60000, { now: NOW }), NOW + 60000);
});

test('a ts older than retention falls back too, so no record writes a segment the next boot drops', () => {
  assert.equal(clampObservedTs(NOW - (DEFAULT_MEMORY_RETAIN_DAYS + 5) * DAY, { now: NOW }), NOW);
  assert.equal(clampObservedTs(NOW - 40 * DAY, { now: NOW, retainDays: 30 }), NOW);
});

test('a record built from a future-dated transcript line lands in the CURRENT segment', () => {
  const built = buildMemoryRecord({
    kind: 'knowledge',
    ts: NOW + 900 * DAY,
    source: { kind: 'reported', vendor: 'claude', sessionId: null },
    text: 'claude: a line stamped in the far future',
  }, { now: NOW });
  assert.equal(built.ok, true);
  assert.equal(built.record.ts, NOW);
  assert.equal(built.record.validFrom, NOW);
  assert.equal(segmentKeyForTs(built.record.ts), segmentKeyForTs(NOW));
});
