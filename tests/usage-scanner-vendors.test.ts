import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUsageScanner } from '../server/usage-scanner.ts';
import type { UsageScannerOptions } from '../server/usage-scanner.ts';
import { normalizePricingTable } from '../server/core/usage-pricing-core.ts';
import { codexDedupIdentity } from '../server/core/usage-codex-core.ts';
import { grokDedupIdentity } from '../server/core/usage-grok-core.ts';
import { dedupKeys } from '../server/core/usage-entry-core.ts';

type Scanner = ReturnType<typeof createUsageScanner>;
type UsageReport = ReturnType<Scanner['buildReport']>;

const NOW = Date.parse('2026-07-09T00:00:00.000Z');

const pricingTable = normalizePricingTable({
  'claude-sonnet-4-20250514': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
  'gpt-5.5': { input_cost_per_token: 0.000005, output_cost_per_token: 0.00003, cache_read_input_token_cost: 5e-7 },
});

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'glissa-usage-vendors-'));
}

function makeScanner(root: string, overrides: UsageScannerOptions = {}): Scanner {
  return createUsageScanner({
    env: { HOME: root },
    pricingTable,
    nowFn: () => NOW,
    ...overrides,
  });
}

async function writeLines(file: string, lines: string[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${lines.join('\n')}\n`);
}

function codexTurnContext(model: string): string {
  return JSON.stringify({
    timestamp: '2026-07-08T22:50:21.513Z',
    type: 'turn_context',
    payload: { turn_id: 'turn-1', model, cwd: 'C:/repo' },
  });
}

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

function codexTokenCount({ total, last = null, timestamp = '2026-07-08T22:50:28.569Z' }: {
  total: CodexUsage;
  last?: CodexUsage | null;
  timestamp?: string;
}): string {
  const info: Record<string, unknown> = { total_token_usage: total, model_context_window: 258400 };
  if (last) info.last_token_usage = last;
  return JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info } });
}

function codexUsage({ input, cached = 0, output, cacheWrite = 0 }: {
  input: number;
  cached?: number;
  output: number;
  cacheWrite?: number;
}): CodexUsage {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function grokLine({ promptId, model = 'grok-4.6', input = 1000, output = 100, cachedRead = 400, ticks = 1680640000, sessionId = 'grok-session-1', agentTimestampMs = Date.parse('2026-07-08T23:00:00.000Z') }: {
  promptId: string;
  model?: string;
  input?: number;
  output?: number;
  cachedRead?: number;
  ticks?: number;
  sessionId?: string;
  agentTimestampMs?: number;
}): string {
  const counts = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cachedReadTokens: cachedRead,
    costUsdTicks: ticks,
  };
  return JSON.stringify({
    timestamp: Math.floor(agentTimestampMs / 1000),
    method: '_x.ai/session/update',
    params: {
      sessionId,
      _meta: { agentTimestampMs },
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: promptId,
        usage: { ...counts, modelUsage: { [model]: counts } },
      },
    },
  });
}

function claudeLine({ messageId, input = 100, output = 10 }: { messageId: string; input?: number; output?: number }): string {
  return JSON.stringify({
    sessionId: 'claude-inline-1',
    requestId: `req-${messageId}`,
    timestamp: '2026-07-08T22:00:00.000Z',
    cwd: 'C:/repo',
    isSidechain: false,
    message: {
      id: messageId,
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
}

test('codex: sessions/ is walked, and the home root itself is not (it holds non-usage jsonl)', async () => {
  const root = await makeTempRoot();
  await writeLines(path.join(root, '.codex', 'sessions', '2026', '07', '08', 'rollout-2026-07-08T16-47-47-019f43ea-76ac-7041-bd4b-6362e85f6630.jsonl'), [
    codexTurnContext('gpt-5.5'),
    codexTokenCount({ total: codexUsage({ input: 1000, cached: 400, output: 50 }) }),
  ]);

  await writeLines(path.join(root, '.codex', 'history.jsonl'), [JSON.stringify({ session_id: 'x', ts: 1 })]);
  await writeLines(path.join(root, '.codex', '.tmp', 'plugins', 'responses.jsonl'), [
    codexTurnContext('gpt-5.5'),
    codexTokenCount({ total: codexUsage({ input: 999999, cached: 0, output: 999 }) }),
  ]);

  const scanner = makeScanner(root);
  const pass = await scanner.runPass();
  assert.equal(pass.files, 1, 'only the sessions/ rollout is a usage file');
  const report = scanner.buildReport({});
  const models = report.models.map((row) => `${row.vendor}/${row.model}`);
  assert.deepEqual(models, ['codex/gpt-5.5']);

  assert.equal(report.models[0].input, 600);
  assert.equal(report.models[0].cacheRead, 400);
  assert.equal(report.models[0].output, 50);
});

test('codex: the home is a flat jsonl dir only when neither sessions/ nor archived_sessions/ exists', async () => {
  const root = await makeTempRoot();
  await writeLines(path.join(root, '.codex', 'loose-019f43ea-76ac-7041-bd4b-6362e85f6630.jsonl'), [
    codexTurnContext('gpt-5.5'),
    codexTokenCount({ total: codexUsage({ input: 200, output: 20 }) }),
  ]);
  const report = await scanOnce(makeScanner(root));
  assert.deepEqual(report.models.map((row) => row.model), ['gpt-5.5']);
});

test('codex: an archived copy of the same rollout does not double count, and the active copy wins', async () => {
  const root = await makeTempRoot();
  const name = 'rollout-2026-07-08T16-47-47-019f43ea-76ac-7041-bd4b-6362e85f6630.jsonl';
  const active = [codexTurnContext('gpt-5.5'), codexTokenCount({ total: codexUsage({ input: 1000, output: 100 }) })];

  const archived = [codexTurnContext('gpt-5.5'), codexTokenCount({ total: codexUsage({ input: 500, output: 50 }) })];
  await writeLines(path.join(root, '.codex', 'sessions', '2026', '07', '08', name), active);
  await writeLines(path.join(root, '.codex', 'archived_sessions', name), archived);

  const scanner = makeScanner(root);
  const pass = await scanner.runPass();
  assert.equal(pass.files, 1, 'the duplicate is resolved before reading');
  const report = await scanner.buildReport({});
  assert.equal(report.models.length, 1);
  assert.equal(report.models[0].output, 100, 'the active copy is the one read');
});

test('codex: an append continues the cumulative snapshot instead of re-counting the session', async () => {
  const root = await makeTempRoot();
  const file = path.join(root, '.codex', 'sessions', '2026', '07', '08', 'rollout-a-019f43ea-76ac-7041-bd4b-6362e85f6630.jsonl');
  await writeLines(file, [
    codexTurnContext('gpt-5.5'),
    codexTokenCount({ total: codexUsage({ input: 1000, output: 100 }) }),
  ]);
  const scanner = makeScanner(root);
  await scanner.runPass();
  const first = scanner.buildReport({});
  assert.equal(first.totals.output, 100);

  await fs.appendFile(file, `${codexTokenCount({ total: codexUsage({ input: 2500, output: 250 }), timestamp: '2026-07-08T22:55:00.000Z' })}\n`);
  const second = await scanner.runPass();
  assert.equal(second.newEntries, 1);
  const report = scanner.buildReport({});
  assert.equal(report.totals.output, 250, 'cumulative totals stayed cumulative across the append');
  assert.equal(report.models[0].model, 'gpt-5.5', 'the model carried across the append too');
});

test('codex: entries are priced from the gpt table and never reported as missing pricing', async () => {
  const root = await makeTempRoot();
  await writeLines(path.join(root, '.codex', 'sessions', 'rollout-019f43ea-76ac-7041-bd4b-6362e85f6630.jsonl'), [
    codexTurnContext('gpt-5.5'),
    codexTokenCount({ total: codexUsage({ input: 1000, cached: 0, output: 100 }) }),
  ]);
  const report = await scanOnce(makeScanner(root));

  assert.ok(Math.abs(report.totals.costUSD - 0.008) < 1e-9, `priced from the table: ${report.totals.costUSD}`);
  assert.deepEqual(report.pricing.missing, []);
});

test('grok: only sessions/**/updates.jsonl is read, and the transcript cost is kept', async () => {
  const root = await makeTempRoot();
  const sessionDir = path.join(root, '.grok', 'sessions', 'C%3A%5Crepo', '019fde0f-453b-72a3-bf55-d1fd726cb2ad');
  await writeLines(path.join(sessionDir, 'updates.jsonl'), [grokLine({ promptId: 'prompt-1' })]);

  await writeLines(path.join(sessionDir, 'messages.jsonl'), [grokLine({ promptId: 'prompt-ignored', ticks: 990000000000 })]);

  const scanner = makeScanner(root);
  const pass = await scanner.runPass();
  assert.equal(pass.files, 1);
  const report = scanner.buildReport({});
  assert.equal(report.models.length, 1);
  assert.equal(report.models[0].vendor, 'grok');
  assert.equal(report.models[0].model, 'grok-4.6');

  assert.ok(Math.abs(report.totals.costUSD - 0.168064) < 1e-9, `ticks became dollars: ${report.totals.costUSD}`);
});

test('grok: a model with no price table entry is never reported as missing pricing', async () => {
  const root = await makeTempRoot();
  await writeLines(path.join(root, '.grok', 'sessions', 'cwd', 'sess', 'updates.jsonl'), [
    grokLine({ promptId: 'prompt-1', model: 'grok-9-unknown' }),
  ]);
  const report = await scanOnce(makeScanner(root));
  assert.equal(report.models[0].model, 'grok-9-unknown');
  assert.deepEqual(report.pricing.missing, [], 'grok prices itself, so it is not a pricing gap');
});

test('grok: prompt_id dedups a line seen twice across passes', async () => {
  const root = await makeTempRoot();
  const file = path.join(root, '.grok', 'sessions', 'cwd', 'sess', 'updates.jsonl');
  await writeLines(file, [grokLine({ promptId: 'prompt-1' })]);
  const scanner = makeScanner(root);
  await scanner.runPass();

  const forced = await scanner.runPass({ force: true });
  assert.equal(forced.entries, 1);
});

test('three vendors in one report: split totals, tagged models, and Claude-only block surfaces', async () => {
  const root = await makeTempRoot();
  await writeLines(path.join(root, '.claude', 'projects', 'C--repo', 'claude-session.jsonl'), [
    claudeLine({ messageId: 'message-a', input: 1000, output: 100 }),
  ]);
  await writeLines(path.join(root, '.codex', 'sessions', 'rollout-019f43ea-76ac-7041-bd4b-6362e85f6630.jsonl'), [
    codexTurnContext('gpt-5.5'),
    codexTokenCount({ total: codexUsage({ input: 2000, output: 200 }) }),
  ]);
  await writeLines(path.join(root, '.grok', 'sessions', 'cwd', 'sess', 'updates.jsonl'), [
    grokLine({ promptId: 'prompt-1', input: 3000, output: 300, cachedRead: 0 }),
  ]);

  const report = await scanOnce(makeScanner(root));
  assert.deepEqual(Object.keys(report.totals.byVendor).sort(), ['claude', 'codex', 'grok']);
  assert.equal(report.totals.byVendor.claude.tokens, 1100);
  assert.equal(report.totals.byVendor.codex.tokens, 2200);
  assert.equal(report.totals.byVendor.grok.tokens, 3300);
  assert.equal(report.totals.tokens, 6600, 'the grand total is every vendor');

  const byModel = new Map(report.models.map((row) => [row.model, row.vendor]));
  assert.equal(byModel.get('claude-sonnet-4-20250514'), 'claude');
  assert.equal(byModel.get('gpt-5.5'), 'codex');
  assert.equal(byModel.get('grok-4.6'), 'grok');

  for (const row of report.sessions) assert.ok(['claude', 'codex', 'grok'].includes(row.vendor), `session vendor: ${row.vendor}`);

  assert.ok(report.daily.every((day) => Array.isArray(day.vendors)));

  const blockTokens = report.blocks.reduce((sum, block) => sum + block.tokens, 0);
  assert.equal(blockTokens, 1100, 'blocks are Claude-only');

  const totals = await scannerSessionTotals(root);
  assert.deepEqual(
    [...totals.keys()].sort(),
    ['019f43ea-76ac-7041-bd4b-6362e85f6630', 'claude-inline-1', 'grok-session-1'],
  );
});

test('the vendor kill switches skip the walk entirely', async () => {
  const root = await makeTempRoot();
  await writeLines(path.join(root, '.claude', 'projects', 'C--repo', 'claude-session.jsonl'), [
    claudeLine({ messageId: 'message-a' }),
  ]);
  await writeLines(path.join(root, '.codex', 'sessions', 'rollout-019f43ea-76ac-7041-bd4b-6362e85f6630.jsonl'), [
    codexTurnContext('gpt-5.5'),
    codexTokenCount({ total: codexUsage({ input: 2000, output: 200 }) }),
  ]);
  await writeLines(path.join(root, '.grok', 'sessions', 'cwd', 'sess', 'updates.jsonl'), [
    grokLine({ promptId: 'prompt-1' }),
  ]);

  const off = await scanOnce(makeScanner(root, { vendors: { codex: false, grok: false } }));
  assert.deepEqual(Object.keys(off.totals.byVendor), ['claude'], 'only Claude contributed');
  assert.equal(off.scan.dirs.length, 1, 'no vendor root was even listed');
  assert.equal(off.models.length, 1);

  const codexOnly = await scanOnce(makeScanner(root, { vendors: { codex: true, grok: false } }));
  assert.deepEqual(Object.keys(codexOnly.totals.byVendor).sort(), ['claude', 'codex']);
});

test('a machine with no vendor homes reports exactly one vendor and one root', async () => {
  const root = await makeTempRoot();
  await writeLines(path.join(root, '.claude', 'projects', 'C--repo', 'claude-session.jsonl'), [
    claudeLine({ messageId: 'message-a' }),
  ]);
  const report = await scanOnce(makeScanner(root));

  assert.equal(report.scan.resolutionError, null);
  assert.deepEqual(Object.keys(report.totals.byVendor), ['claude']);
  assert.equal(report.scan.dirs.length, 1);
});

test('dedup identities cannot collide across vendors', async () => {
  const codexKey = codexDedupIdentity({ vendor: 'codex', sessionId: 's', timestampMs: 1, model: 'm', input: 1, output: 1, cacheCreate: 0, cacheRead: 0 });
  const grokKey = grokDedupIdentity({ vendor: 'grok', sessionId: 's', messageId: 'p' });
  const claudeKey = dedupKeys({ messageId: 'm', requestId: 'r' }).primary;
  assert.ok(codexKey, 'the codex core minted an identity');
  assert.ok(grokKey, 'the grok core minted an identity');
  assert.ok(claudeKey, 'the claude core minted an identity');
  assert.ok(codexKey.startsWith('codex:'));
  assert.ok(grokKey.startsWith('grok:'));
  assert.notEqual(codexKey, grokKey);
  assert.notEqual(codexKey, claudeKey);
  assert.notEqual(grokKey, claudeKey);
  assert.equal(claudeKey.startsWith('codex:'), false);
  assert.equal(claudeKey.startsWith('grok:'), false);
});

async function scanOnce(scanner: Scanner): Promise<UsageReport> {
  await scanner.runPass();
  return scanner.buildReport({});
}

async function scannerSessionTotals(root: string) {
  const scanner = makeScanner(root);
  await scanner.runPass();
  return scanner.sessionTotals();
}
