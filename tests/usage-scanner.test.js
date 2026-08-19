'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageScanner } = require('../server/usage-scanner');
const { normalizePricingTable } = require('../server/core/usage-pricing-core');

const pricingTable = normalizePricingTable({
  'claude-sonnet-4-20250514': {
    input_cost_per_token: 1,
    output_cost_per_token: 2,
    cache_creation_input_token_cost: 3,
    cache_read_input_token_cost: 4,
  },
});

test('runPass ingests a fixture tree and append reruns ingest only new entries', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, output: 1, sessionId: 'inline-a' }),
    usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20, output: 1, sessionId: 'inline-a' }),
  ]);
  const scanner = makeScanner(root);

  const first = await scanner.runPass();
  assert.equal(first.files, 1);
  assert.equal(first.entries, 2);
  assert.equal(first.newEntries, 2);
  assert.equal(scanner.stats().entries, 2);

  const firstSize = (await fs.stat(transcript)).size;
  await fs.appendFile(transcript, `${usageLine({ messageId: 'message-c', requestId: 'request-c', input: 30, output: 1, sessionId: 'inline-a' })}\n`);
  const second = await scanner.runPass();
  assert.equal(second.entries, 3);
  assert.equal(second.newEntries, 1);
  assert.equal(scanner.sessionTotals().get('inline-a').tokens, 63);
  assert.ok((await fs.stat(transcript)).size > firstSize);
});

test('truncation restarts the file and dedup prevents surviving entries from duplicating', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const survivingLine = usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 });
  await writeLines(transcript, [
    survivingLine,
    usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 }),
  ]);
  const scanner = makeScanner(root);
  assert.equal((await scanner.runPass()).entries, 2);

  await writeLines(transcript, [survivingLine]);
  const second = await scanner.runPass();
  assert.equal(second.entries, 2);
  assert.equal(second.newEntries, 0);
});

test('chunk decoding preserves a split multi-byte character', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const cjk = String.fromCharCode(0x4e2d);
  await writeLines(transcript, [usageLine({ messageId: `message-${cjk}`, requestId: 'request-a', input: 10 })]);
  const scanner = makeScanner(root, { chunkSize: 2 });

  await scanner.runPass();
  const report = scanner.buildReport();
  assert.equal(report.totals.tokens, 10);
  assert.equal(report.pricing.missing.length, 0);
});

test('an unreadable file is skipped while other files ingest', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const readable = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const unreadable = path.join(projectsDir, 'C--repo', 'session-b.jsonl');
  await writeLines(readable, [usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 })]);
  await writeLines(unreadable, [usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 })]);
  const injectedFs = {
    ...fs,
    open: async (file, flags) => {
      if (file === unreadable) throw new Error('denied');
      return fs.open(file, flags);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const result = await scanner.runPass();
  assert.equal(result.files, 2);
  assert.equal(result.entries, 1);
  assert.equal(result.newEntries, 1);
});

test('dedup across configured dirs keeps one entry', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const extraHome = path.join(root, 'extra-claude');
  const extraProjectsDir = path.join(extraHome, 'projects');
  const line = usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 });
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [line]);
  await writeLines(path.join(extraProjectsDir, 'C--repo', 'session-b.jsonl'), [line]);
  const scanner = makeScanner(root, { extraProjectsDirs: [extraHome] });

  const result = await scanner.runPass();
  assert.equal(result.files, 2);
  assert.equal(result.entries, 1);
  assert.equal(result.newEntries, 1);
});

test('runPass is single-flight', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 }),
  ]);
  let statCalls = 0;
  const injectedFs = {
    ...fs,
    stat: async (file) => {
      statCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fs.stat(file);
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const first = scanner.runPass();
  const second = scanner.runPass();
  assert.equal(first, second);
  assert.equal((await first).entries, 1);
  assert.ok(statCalls > 0);
});

test('partial pass resumes on the next pass', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 }),
    usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 }),
    usageLine({ messageId: 'message-c', requestId: 'request-c', input: 30 }),
  ]);
  const scanner = makeScanner(root, { byteBudget: 500, chunkSize: 500 });

  const first = await scanner.runPass();
  assert.equal(first.partial, true);
  assert.ok(first.entries < 3);
  const second = await scanner.runPass();
  assert.equal(second.partial, false);
  assert.equal(second.entries, 3);
});

test('sidechain replacement reindexes in place and marks the report dirty', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [
    usageLine({ messageId: 'message-a', requestId: 'request-side', input: 5, isSidechain: true }),
  ]);
  const scanner = makeScanner(root);

  await scanner.runPass();
  const staleReport = scanner.buildReport();
  assert.equal(staleReport.totals.tokens, 5);

  await fs.appendFile(transcript, `${usageLine({ messageId: 'message-a', requestId: 'request-main', input: 11 })}\n`);
  const replacement = await scanner.runPass();
  assert.equal(replacement.entries, 1);
  assert.equal(replacement.newEntries, 0);
  assert.equal(scanner.buildReport().totals.tokens, 11);

  await fs.appendFile(transcript, `${usageLine({ messageId: 'message-a', requestId: 'request-side', input: 5, isSidechain: true })}\n`);
  await fs.appendFile(transcript, `${usageLine({ messageId: 'message-a', requestId: 'request-main', input: 11 })}\n`);
  await scanner.runPass();
  assert.equal(scanner.buildReport().totals.tokens, 11);
});

test('report time fields are fresh when no entries changed', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, timestamp: '2026-08-19T10:00:00.000Z' }),
  ]);
  let now = Date.parse('2026-08-19T12:00:00.000Z');
  const scanner = makeScanner(root, { nowFn: () => now, blockHours: 5 });

  await scanner.runPass();
  const first = scanner.buildReport();
  assert.equal(first.activeBlock.isActive, true);

  now = Date.parse('2026-08-20T23:00:00.000Z');
  await scanner.runPass();
  const second = scanner.buildReport();
  assert.equal(second.ts, now);
  assert.equal(second.activeBlock, null);
});

test('id-less entries dedup across force rebuilds and force reingests once', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [
    usageLine({ messageId: undefined, requestId: undefined, input: 10 }),
  ]);
  const scanner = makeScanner(root);

  await scanner.runPass({ force: true });
  await scanner.runPass({ force: true });
  assert.equal(scanner.buildReport().totals.tokens, 10);

  await fs.appendFile(transcript, `${usageLine({ messageId: undefined, requestId: undefined, input: 20 })}\n`);
  await scanner.runPass({ force: true });
  assert.equal(scanner.buildReport().totals.tokens, 30);
  assert.equal(scanner.stats().entries, 2);
});

test('missing model tracking respects mode, tokens and pruning', async () => {
  const displayRoot = await makeTempRoot();
  const displayProjectsDir = await makeProjectsDir(displayRoot);
  await writeLines(path.join(displayProjectsDir, 'C--repo', 'display.jsonl'), [
    usageLine({ messageId: 'display-a', requestId: 'request-a', model: 'unknown-model', input: 10 }),
  ]);
  const displayScanner = makeScanner(displayRoot, { costMode: 'display' });
  await displayScanner.runPass();
  assert.deepEqual(displayScanner.buildReport().pricing.missing, []);

  const zeroRoot = await makeTempRoot();
  const zeroProjectsDir = await makeProjectsDir(zeroRoot);
  await writeLines(path.join(zeroProjectsDir, 'C--repo', 'zero.jsonl'), [
    usageLine({ messageId: 'zero-a', requestId: 'request-a', model: 'unknown-model', input: 0 }),
  ]);
  const zeroScanner = makeScanner(zeroRoot);
  await zeroScanner.runPass();
  assert.deepEqual(zeroScanner.buildReport().pricing.missing, []);

  const pruneRoot = await makeTempRoot();
  const pruneProjectsDir = await makeProjectsDir(pruneRoot);
  await writeLines(path.join(pruneProjectsDir, 'C--repo', 'prune.jsonl'), [
    usageLine({ messageId: 'prune-a', requestId: 'request-a', model: 'unknown-model', input: 10 }),
  ]);
  let now = Date.parse('2026-08-19T12:00:00.000Z');
  const pruneScanner = makeScanner(pruneRoot, { nowFn: () => now, retainDays: 1 });
  await pruneScanner.runPass();
  assert.deepEqual(pruneScanner.buildReport().pricing.missing, ['unknown-model']);
  now = Date.parse('2026-08-21T12:00:00.000Z');
  await pruneScanner.runPass();
  assert.deepEqual(pruneScanner.buildReport().pricing.missing, []);
});

test('stored entries strip ingest-only iteration payloads', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, iterations: [{ type: 'other', usage: { input_tokens: 99 } }] }),
  ]);
  const scanner = makeScanner(root);

  await scanner.runPass();
  assert.equal(Object.prototype.hasOwnProperty.call(scanner._entriesForTest()[0], 'iterations'), false);
});

test('force requested during an active pass chains a rebuild pass', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  await writeLines(transcript, [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 }),
  ]);
  let fileStatCalls = 0;
  const injectedFs = {
    ...fs,
    stat: async (file) => {
      const stat = await fs.stat(file);
      if (!file.endsWith('.jsonl')) return stat;
      fileStatCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return stat;
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs });

  const active = scanner.runPass();
  const forced = scanner.runPass({ force: true });
  assert.equal(active, forced);
  const result = await forced;
  assert.equal(result.entries, 1);
  assert.ok(fileStatCalls >= 2);
});

test('resolution errors are captured in stats', async () => {
  const root = await makeTempRoot();
  const scanner = makeScanner(root, {
    env: { HOME: root, CLAUDE_CONFIG_DIR: 'C:/missing' },
    fsPromises: {
      ...fs,
      stat: async () => ({ isDirectory: () => false }),
      readdir: async () => [],
    },
  });

  await scanner.runPass();
  assert.match(scanner.stats().resolutionError, /CLAUDE_CONFIG_DIR/);
});

test('partial byte budget does not flush an incomplete utf8 sequence', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const cjk = String.fromCharCode(0x4e2d);
  const model = `claude-sonnet-4-20250514-${cjk}`;
  const line = usageLineWithModelLast({ messageId: 'message-a', requestId: 'request-a', model, input: 10 });
  const bytesBeforeCjk = Buffer.byteLength(line.slice(0, line.indexOf(cjk)));
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [line]);
  const scanner = makeScanner(root, { byteBudget: bytesBeforeCjk + 1, chunkSize: bytesBeforeCjk + 1 });

  const first = await scanner.runPass();
  assert.equal(first.partial, true);
  assert.equal(first.entries, 0);
  const second = await scanner.runPass();
  assert.equal(second.partial, false);
  const report = scanner.buildReport();
  assert.equal(report.totals.tokens, 10);
  assert.equal(report.models[0].model.includes(String.fromCharCode(0xfffd)), false);
});

test('report and session total memo results are mutation safe', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10, sessionId: 'inline-a' }),
  ]);
  const scanner = makeScanner(root);

  await scanner.runPass();
  const report = scanner.buildReport();
  report.daily[0].tokens = 999;
  const totals = scanner.sessionTotals();
  totals.get('inline-a').tokens = 999;

  assert.equal(scanner.buildReport().daily[0].tokens, 10);
  assert.equal(scanner.sessionTotals().get('inline-a').tokens, 10);
});

test('requested days window filters rollups and blocks consistently', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'old-a', requestId: 'request-a', input: 10, timestamp: '2026-08-17T12:00:00.000Z' }),
    usageLine({ messageId: 'new-a', requestId: 'request-b', input: 20, timestamp: '2026-08-19T12:00:00.000Z' }),
  ]);
  const scanner = makeScanner(root, { nowFn: () => Date.parse('2026-08-19T13:00:00.000Z') });

  await scanner.runPass();
  const report = scanner.buildReport({ days: 1 });
  assert.equal(report.totals.tokens, 20);
  assert.equal(report.blocks.length, 1);
  assert.equal(report.activeBlock.tokens, 20);
});

test('prune removes entries and dedup keys so a pruned line can reingest once', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const oldLine = usageLine({ messageId: 'old-a', requestId: 'request-a', input: 10, timestamp: '2026-08-19T12:00:00.000Z' });
  await writeLines(transcript, [oldLine]);
  let now = Date.parse('2026-08-19T13:00:00.000Z');
  const scanner = makeScanner(root, { nowFn: () => now, retainDays: 1 });

  await scanner.runPass();
  assert.equal(scanner.buildReport().totals.tokens, 10);
  now = Date.parse('2026-08-21T13:00:00.000Z');
  await scanner.runPass();
  assert.equal(scanner.buildReport().totals.tokens, 0);

  await fs.appendFile(transcript, `${oldLine}\n`);
  await scanner.runPass();
  assert.equal(scanner.buildReport().totals.tokens, 0);
  now = Date.parse('2026-08-19T13:00:00.000Z');
  await scanner.runPass({ force: true });
  assert.equal(scanner.buildReport().totals.tokens, 10);
});

test('mid-file read failure rolls back file state and entries', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  const firstLine = usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 });
  await writeLines(transcript, [
    firstLine,
    usageLine({ messageId: 'message-b', requestId: 'request-b', input: 20 }),
  ]);
  let shouldFail = true;
  const injectedFs = {
    ...fs,
    open: async (file, flags) => {
      const handle = await fs.open(file, flags);
      if (file !== transcript) return handle;
      let readCalls = 0;
      return {
        read: async (...args) => {
          readCalls += 1;
          if (shouldFail && readCalls > 1) throw new Error('mid file');
          return handle.read(...args);
        },
        close: () => handle.close(),
      };
    },
  };
  const scanner = makeScanner(root, { fsPromises: injectedFs, chunkSize: Buffer.byteLength(firstLine) + 1 });

  const failed = await scanner.runPass();
  assert.equal(failed.entries, 0);
  shouldFail = false;
  const recovered = await scanner.runPass();
  assert.equal(recovered.entries, 2);
  assert.equal(scanner.buildReport().totals.tokens, 30);
});

test('stats reports dirs, files, entries and lastScanMs', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'message-a', requestId: 'request-a', input: 10 }),
  ]);
  const scanner = makeScanner(root);

  await scanner.runPass();
  const stats = scanner.stats();
  assert.deepEqual(stats.dirs, [projectsDir]);
  assert.equal(stats.files, 1);
  assert.equal(stats.entries, 1);
  assert.equal(stats.lastScanMs, Date.parse('2026-08-19T12:00:00.000Z'));
});

// Without the retention floor, retainDays: 7 compares a month's ceiling against seven days of spend.
test('budgetSpend sees the whole month even when retainDays is shorter than it', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  const transcript = path.join(projectsDir, 'C--repo', 'session-a.jsonl');
  // Three days spread across the month, two of them outside a 7 day window ending Aug 19.
  await writeLines(transcript, [
    usageLine({ messageId: 'm-early', requestId: 'r1', input: 1000, timestamp: '2026-08-02T10:00:00.000Z' }),
    usageLine({ messageId: 'm-mid', requestId: 'r2', input: 1000, timestamp: '2026-08-09T10:00:00.000Z' }),
    usageLine({ messageId: 'm-today', requestId: 'r3', input: 1000, timestamp: '2026-08-19T10:00:00.000Z' }),
  ]);
  const scanner = makeScanner(root, { retainDays: 7, budget: { monthlyUsd: 100 } });
  await scanner.runPass();

  const spend = scanner.budgetSpend();
  assert.equal(spend.todayKey, '2026-08-19');
  assert.equal(spend.monthKey, '2026-08');
  // Every day of the month counts, not just the ones inside the 7 day transcript window.
  assert.equal(spend.monthUsd > spend.todayUsd, true, `month ${spend.monthUsd} should exceed today ${spend.todayUsd}`);
  assert.equal(Math.round(spend.monthUsd / spend.todayUsd), 3, 'all three days');
  // The report itself still honors retainDays: widening is for the budget lookback alone.
  assert.equal(scanner.buildReport({}).daily.length, 1, 'the report window is untouched');

  // Without a monthly budget the operator's retention choice is honored exactly.
  const narrow = makeScanner(root, { retainDays: 7 });
  await narrow.runPass();
  assert.equal(narrow.budgetSpend().monthUsd, narrow.budgetSpend().todayUsd, 'no budget, no widening');
});

test('budgetSpend shares the report rollups when retainDays already covers the month', async () => {
  const root = await makeTempRoot();
  const projectsDir = await makeProjectsDir(root);
  await writeLines(path.join(projectsDir, 'C--repo', 'session-a.jsonl'), [
    usageLine({ messageId: 'm1', requestId: 'r1', input: 1000, timestamp: '2026-08-19T10:00:00.000Z' }),
  ]);
  // The default retainDays (90) is always longer than a month, so nothing is widened and no second
  // aggregate pass is computed.
  const scanner = makeScanner(root);
  await scanner.runPass();
  const spend = scanner.budgetSpend();
  assert.equal(spend.todayUsd, spend.monthUsd);
  assert.equal(spend.monthUsd > 0, true);
});

function makeScanner(root, overrides = {}) {
  return createUsageScanner({
    env: { HOME: root },
    pricingTable,
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
    ...overrides,
  });
}

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'glissa-usage-scanner-'));
}

async function makeProjectsDir(root) {
  const projectsDir = path.join(root, '.claude', 'projects');
  await fs.mkdir(projectsDir, { recursive: true });
  return projectsDir;
}

async function writeLines(file, lines) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${lines.join('\n')}\n`);
}

function usageLine({
  messageId,
  requestId,
  input = 1,
  output = 0,
  sessionId = 'session-a',
  model = 'claude-sonnet-4-20250514',
  timestamp = '2026-08-19T10:00:00.000Z',
  isSidechain = false,
  iterations = [],
}) {
  return JSON.stringify({
    timestamp,
    sessionId,
    requestId,
    cwd: 'C:/repo',
    version: '2.1.200',
    isSidechain,
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations,
      },
    },
  });
}

function usageLineWithModelLast({ messageId, requestId, model, input }) {
  return JSON.stringify({
    timestamp: '2026-08-19T10:00:00.000Z',
    sessionId: 'session-a',
    requestId,
    cwd: 'C:/repo',
    version: '2.1.200',
    isSidechain: false,
    message: {
      id: messageId,
      usage: {
        input_tokens: input,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model,
    },
  });
}
