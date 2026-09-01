import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fixtureReason, purgeFixtures } from '../scripts/memory-purge-fixtures.ts';
import { createMemoryStore } from '../server/memory-store.ts';
import { resolveMemoryConfig } from '../server/core/memory-core.ts';

const QUIET = { log() {}, warn() {} };
const CANARY = 'the merge gate lives in session/core/merge-gate.ts';

interface KnowledgeInput {
  kind: string;
  layer: string;
  project: string | null;
  source: { kind: string; vendor: string; sessionId: string | null };
  text: string;
}

interface CapturedOut {
  lines: string[];
  log: (line: string) => void;
  error: (line: string) => void;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-purge-'));
}

function knowledge(text: string, project: string | null, sessionId: string): KnowledgeInput {
  return {
    kind: 'knowledge',
    layer: 'semantic',
    project,
    source: { kind: 'reported', vendor: 'claude', sessionId },
    text,
  };
}

function silentOut(): CapturedOut {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line), error: (line) => lines.push(line) };
}

async function seedStore(dir: string, realProject: string): Promise<number> {
  const store = createMemoryStore({
    dir,
    dbPath: path.join(dir, 'glissa.db'),
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: QUIET,
    projectionDebounceMs: 5,
  });
  if (!store) throw new Error('this node build has no node:sqlite');
  await store.append(knowledge(CANARY, '/repos/glissa', 'sess-1'));
  await store.append(knowledge('the poller ticks every 15 minutes', 'repo/fixture', 's-1'));
  await store.append(knowledge('the review sidebar reads the worktree diff', realProject, 'a1f0c1de-0000-4000-8000-000000000003'));
  await store.append(knowledge('a fixture that borrowed a real project path', realProject, 'sess-2'));
  await store.append(knowledge('the operator prefers early returns in every lane', realProject, 'b3f0c1de-0000-4000-8000-000000000001'));
  await store.append(knowledge('the rebase gate refuses a dirty worktree outright', null, 'c4f0c1de-0000-4000-8000-000000000002'));
  const liveTranscript = path.join(dir, 'live.jsonl');
  fs.writeFileSync(liveTranscript, '{}\n', 'utf8');
  store.saveTailOffset({ path: liveTranscript, size: 3, mtimeMs: 1, offset: 3, ts: 1 });
  store.saveTailOffset({ path: path.join(os.tmpdir(), 'glissa-gone-fixture', 'sess-1.jsonl'), size: 3, mtimeMs: 1, offset: 3, ts: 1 });
  const total = store.records().length;
  await store.stop();
  return total;
}

test('the fixture rule keeps a real project, a global record and a tombstone', () => {
  const real = tempDir();
  try {
    assert.equal(fixtureReason(knowledge('x', 'repo/fixture', 'u-1')), 'project', 'a relative key never named a place here');
    assert.equal(fixtureReason(knowledge('x', '/repos/glissa', 'u-1')), 'project', 'no such root on this machine');
    assert.equal(fixtureReason(knowledge('x', path.join(real, 'pruned-worktree'), 'u-1')), null, 'a pruned worktree is still a real project');
    assert.equal(fixtureReason(knowledge('x', real, 'sess-1')), 'session');
    assert.equal(fixtureReason(knowledge('x', real, 'b3f0c1de-0000-4000-8000-000000000001')), null);
    assert.equal(fixtureReason(knowledge('x', null, 'b3f0c1de-0000-4000-8000-000000000001')), null, 'a global record is judged by its session alone');
    assert.equal(fixtureReason({ kind: 'tombstone', project: null, source: { sessionId: null } }), null);
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test('a purge removes the fixtures, backs the database up first and leaves the real records', async () => {
  const dir = tempDir();
  const realProject = tempDir();
  try {
    const before = await seedStore(dir, realProject);
    assert.equal(before, 6);
    const dbPath = path.join(dir, 'glissa.db');
    const out = silentOut();
    const result = await purgeFixtures({ dbPath, memoryDir: dir, now: () => 1234567890123, out });

    assert.equal(result.ok, true);
    assert.equal(result.before, 6);
    assert.equal(result.removed, 3);
    assert.equal(fs.existsSync(`${dbPath}.bak-1234567890123`), true, 'the backup lands before the first delete');
    assert.ok(out.lines.some((line) => line.startsWith('before: 6 record(s), 6 of them remembered text')));
    assert.ok(out.lines.some((line) => line.startsWith('after: ')));
    assert.equal(result.indexed, result.after, 'the search index was rebuilt from the surviving canon');
    assert.equal(result.tails, 1, 'the offset for a temp transcript that no longer exists is dropped');

    const store = createMemoryStore({
      dir,
      dbPath,
      config: { ...resolveMemoryConfig(null), enabled: true },
      logger: QUIET,
    });
    if (!store) throw new Error('this node build has no node:sqlite');
    assert.deepEqual(Object.keys(store.tailState().files), [path.join(dir, 'live.jsonl')], 'a live transcript keeps its offset');
    const survivors = store.records();
    const kinds = survivors.map((record) => record.kind);
    assert.equal(kinds.includes('tombstone'), true, 'the expunge left its audit trail');
    const texts = survivors.map((record) => record.text).join('\n');
    assert.equal(texts.includes(CANARY), false, 'the fixture text is gone from the canon');
    assert.equal(texts.includes('the review sidebar reads the worktree diff'), true);
    assert.equal(texts.includes('the rebase gate refuses a dirty worktree outright'), true, 'a global record survives');
    await store.stop();

    assert.equal(fs.readFileSync(dbPath).includes(CANARY), false, 'no freed page still holds the fixture text');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(realProject, { recursive: true, force: true });
  }
});

test('a second pass is a no-op that writes nothing, tombstones included', async () => {
  const dir = tempDir();
  const realProject = tempDir();
  try {
    await seedStore(dir, realProject);
    const dbPath = path.join(dir, 'glissa.db');
    await purgeFixtures({ dbPath, memoryDir: dir, now: () => 1, out: silentOut() });
    const second = await purgeFixtures({ dbPath, memoryDir: dir, now: () => 2, out: silentOut() });
    assert.equal(second.removed, 0);
    assert.deepEqual(second.backups, [], 'a no-op pass leaves no second backup behind');
    assert.equal(second.before, second.after);
    assert.equal(fs.existsSync(`${dbPath}.bak-2`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(realProject, { recursive: true, force: true });
  }
});

test('a dry run reports the fixtures and writes nothing', async () => {
  const dir = tempDir();
  const realProject = tempDir();
  try {
    await seedStore(dir, realProject);
    const dbPath = path.join(dir, 'glissa.db');
    const out = silentOut();
    const result = await purgeFixtures({ dbPath, memoryDir: dir, dryRun: true, now: () => 7, out });
    assert.equal(result.removed, 0);
    assert.equal(result.before, result.after);
    assert.equal(fs.existsSync(`${dbPath}.bak-7`), false);
    assert.ok(out.lines.some((line) => line.startsWith('fixtures: 3')));
    assert.equal(fs.readFileSync(dbPath).includes(CANARY), true, 'the dry run really did leave the canon alone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(realProject, { recursive: true, force: true });
  }
});
