
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUsageScanner } from '../server/usage-scanner.ts';
import type { UsageScannerOptions } from '../server/usage-scanner.ts';
import { normalizePricingTable } from '../server/core/usage-pricing-core.ts';

type Scanner = ReturnType<typeof createUsageScanner>;

interface WarehouseRecord {
  day: string;
  model: string;
  tokens: number;
  costUSD: number;
}

interface WarehouseFile {
  version?: number;
  updatedAt?: unknown;
  records: WarehouseRecord[];
}

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const pricingTable = normalizePricingTable({
  'claude-sonnet-4-20250514': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
});

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'glissa-usage-warehouse-'));
}

function makeScanner(root: string, overrides: UsageScannerOptions = {}): Scanner {
  return createUsageScanner({
    env: { HOME: root },
    pricingTable,
    nowFn: () => NOW,
    retainDays: 90,
    warehousePath: path.join(root, '.glissa', 'usage-warehouse.json'),
    ...overrides,
  });
}

function claudeLine({ messageId, day, model = 'claude-sonnet-4-20250514', input = 1000, output = 100 }: {
  messageId: string;
  day: string;
  model?: string;
  input?: number;
  output?: number;
}): string {
  return JSON.stringify({
    sessionId: 'inline-a',
    requestId: `req-${messageId}`,
    timestamp: `${day}T12:00:00.000Z`,
    cwd: 'C:/repo',
    isSidechain: false,
    message: {
      id: messageId,
      model,
      usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
}

async function writeTranscript(root: string, name: string, lines: string[]): Promise<string> {
  const file = path.join(root, '.claude', 'projects', 'C--repo', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

async function readWarehouse(root: string): Promise<WarehouseFile> {
  const text = await fs.readFile(path.join(root, '.glissa', 'usage-warehouse.json'), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the warehouse file is not a JSON object');
  const { version, updatedAt, records } = parsed as { version?: number; updatedAt?: unknown; records?: unknown };
  if (!Array.isArray(records)) throw new Error('the warehouse file carries no records array');
  return { version, updatedAt, records };
}

async function warehouseExists(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, '.glissa', 'usage-warehouse.json'));
    return true;
  } catch {
    return false;
  }
}

test('a completed pass writes per-day per-model records atomically', async () => {
  const root = await makeTempRoot();
  await writeTranscript(root, 'a.jsonl', [
    claudeLine({ messageId: 'm1', day: '2026-08-17' }),
    claudeLine({ messageId: 'm2', day: '2026-08-18', output: 200 }),
  ]);
  const scanner = makeScanner(root);
  await scanner.runPass();

  const stored = await readWarehouse(root);
  assert.equal(stored.version, 1);
  assert.ok(stored.updatedAt, 'stamped with a write time');
  assert.deepEqual(stored.records.map((record) => record.day), ['2026-08-17', '2026-08-18']);
  assert.equal(stored.records[0].model, 'claude-sonnet-4-20250514');
  assert.equal(stored.records[0].tokens, 1100);
  assert.equal(stored.records[1].tokens, 1200);
  const glissaDir = await fs.readdir(path.join(root, '.glissa'));
  assert.deepEqual(glissaDir, ['usage-warehouse.json']);
});

test('a partial pass writes nothing at all', async () => {
  const root = await makeTempRoot();
  await writeTranscript(root, 'a.jsonl', [claudeLine({ messageId: 'm1', day: '2026-08-17' })]);
  const scanner = makeScanner(root, { byteBudget: 1 });
  const pass = await scanner.runPass();
  assert.equal(pass.partial, true, 'the budget forced a partial pass');
  assert.equal(await warehouseExists(root), false, 'no history file from a partial pass');
});

test('an unchanged rescan does not rewrite the file', async () => {
  const root = await makeTempRoot();
  await writeTranscript(root, 'a.jsonl', [claudeLine({ messageId: 'm1', day: '2026-08-17' })]);
  const scanner = makeScanner(root);
  await scanner.runPass();
  const first = (await fs.stat(path.join(root, '.glissa', 'usage-warehouse.json'))).mtimeMs;
  const firstBody = await fs.readFile(path.join(root, '.glissa', 'usage-warehouse.json'), 'utf8');
  await scanner.runPass();
  const second = await fs.readFile(path.join(root, '.glissa', 'usage-warehouse.json'), 'utf8');
  assert.equal(second, firstBody, 'identical records mean identical bytes');
  assert.ok((await fs.stat(path.join(root, '.glissa', 'usage-warehouse.json'))).mtimeMs >= first);
});

test('a deleted transcript keeps its day in the report, marked as history', async () => {
  const root = await makeTempRoot();
  const oldFile = await writeTranscript(root, 'old.jsonl', [claudeLine({ messageId: 'm1', day: '2026-06-01', output: 500 })]);
  await writeTranscript(root, 'new.jsonl', [claudeLine({ messageId: 'm2', day: '2026-08-18' })]);

  const first = makeScanner(root);
  await first.runPass();
  const before = first.buildReport({});
  assert.deepEqual(before.daily.map((row) => row.day), ['2026-06-01', '2026-08-18']);
  assert.equal(before.daily[0]?.source, undefined, 'a live day carries no history marker');

  await fs.rm(oldFile);
  const second = makeScanner(root);
  await second.runPass();
  const after = second.buildReport({});
  assert.deepEqual(after.daily.map((row) => row.day), ['2026-06-01', '2026-08-18']);
  const remembered = after.daily.find((row) => row.day === '2026-06-01');
  assert.ok(remembered, 'the pruned day survived in the report');
  assert.equal(remembered.source, 'history');
  assert.equal(remembered.tokens, 1500, 'the remembered totals are the ones that were observed');
  assert.equal(remembered.models[0]?.model, 'claude-sonnet-4-20250514');

  assert.equal(after.totals.tokens, 1100, 'totals stay live-only');
  const blockTokens = after.blocks.reduce((sum, block) => sum + block.tokens, 0);
  assert.equal(blockTokens, 1100, 'blocks stay live-only');
});

test('a day the live scan still covers wins over the stored copy', async () => {
  const root = await makeTempRoot();
  await writeTranscript(root, 'a.jsonl', [claudeLine({ messageId: 'm1', day: '2026-08-18', output: 100 })]);
  const first = makeScanner(root);
  await first.runPass();
  assert.equal((await readWarehouse(root)).records[0].tokens, 1100);

  await writeTranscript(root, 'a.jsonl', [
    claudeLine({ messageId: 'm1', day: '2026-08-18', output: 100 }),
    claudeLine({ messageId: 'm2', day: '2026-08-18', output: 300 }),
  ]);
  const second = makeScanner(root);
  await second.runPass();
  const stored = await readWarehouse(root);
  assert.equal(stored.records.length, 1);
  assert.equal(stored.records[0].tokens, 2400, 'replaced, not double counted');
  const report = second.buildReport({});
  assert.equal(report.daily.length, 1);
  assert.equal(report.daily[0]?.source, undefined, 'still a live day');
});

test('retention prunes days past warehouseRetainDays', async () => {
  const root = await makeTempRoot();
  await fs.mkdir(path.join(root, '.glissa'), { recursive: true });
  await fs.writeFile(path.join(root, '.glissa', 'usage-warehouse.json'), JSON.stringify({
    version: 1,
    records: [
      { day: '2020-01-01', model: 'claude-sonnet-4-20250514', tokens: 5, costUSD: 1 },
      { day: '2026-08-01', model: 'claude-sonnet-4-20250514', tokens: 7, costUSD: 2 },
    ],
  }));
  await writeTranscript(root, 'a.jsonl', [claudeLine({ messageId: 'm1', day: '2026-08-18' })]);

  const scanner = makeScanner(root, { warehouseRetainDays: 30 });
  await scanner.runPass();
  const stored = await readWarehouse(root);
  assert.deepEqual(stored.records.map((record) => record.day), ['2026-08-01', '2026-08-18']);
  assert.equal(stored.records.some((record) => record.day === '2020-01-01'), false, 'pruned past retention');
});

test('a corrupt warehouse starts empty, warns, and never crashes the pass', async () => {
  const root = await makeTempRoot();
  await fs.mkdir(path.join(root, '.glissa'), { recursive: true });
  await fs.writeFile(path.join(root, '.glissa', 'usage-warehouse.json'), '{ not json at all');
  await writeTranscript(root, 'a.jsonl', [claudeLine({ messageId: 'm1', day: '2026-08-18' })]);

  const warnings: string[] = [];
  const scanner = makeScanner(root, { logger: { warn: (message: string) => { warnings.push(message); } } });
  const pass = await scanner.runPass();
  assert.equal(pass.partial, false, 'the pass completed regardless');
  assert.ok(warnings.some((message) => message.includes('warehouse')), `warned: ${warnings.join(' | ')}`);
  const stored = await readWarehouse(root);
  assert.deepEqual(stored.records.map((record) => record.day), ['2026-08-18']);
});

test('an unwritable warehouse path degrades to a warning, not a failed scan', async () => {
  const root = await makeTempRoot();
  await writeTranscript(root, 'a.jsonl', [claudeLine({ messageId: 'm1', day: '2026-08-18' })]);
  const warnings: string[] = [];
  const scanner = makeScanner(root, {
    warehousePath: path.join(root, '.glissa', 'usage-warehouse.json'),
    logger: { warn: (message: string) => { warnings.push(message); } },
    fsPromises: brokenWriteFs(),
  });
  const pass = await scanner.runPass();
  assert.equal(pass.entries, 1, 'the scan itself succeeded');
  assert.ok(warnings.some((message) => message.includes('warehouse write failed')), `warned: ${warnings.join(' | ')}`);
  assert.equal(await warehouseExists(root), false, 'the injected failure really did block the write');
});

test('a throwing logger during a failed write still does not fail the scan', async () => {
  const root = await makeTempRoot();
  await writeTranscript(root, 'a.jsonl', [claudeLine({ messageId: 'm1', day: '2026-08-18' })]);
  const scanner = makeScanner(root, {
    logger: { warn: (): void => { throw new Error('logger exploded'); } },
    fsPromises: brokenWriteFs(),
  });
  const pass = await scanner.runPass();
  assert.equal(pass.entries, 1, 'a history write problem never costs the scan');
  assert.equal(await warehouseExists(root), false);
});

test('no warehousePath means the feature is inert: nothing read, nothing written', async () => {
  const root = await makeTempRoot();
  await writeTranscript(root, 'a.jsonl', [claudeLine({ messageId: 'm1', day: '2026-08-18' })]);
  const scanner = makeScanner(root, { warehousePath: null });
  await scanner.runPass();
  assert.equal(await warehouseExists(root), false);
  const report = scanner.buildReport({});
  assert.equal(report.daily.every((row) => row.source === undefined), true);
});

function brokenWriteFs(): NonNullable<UsageScannerOptions['fsPromises']> {
  return {
    ...fs,
    writeFile: async () => { throw new Error('EACCES simulated'); },
  };
}
