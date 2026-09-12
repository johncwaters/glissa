import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUploadsWiring } from '../server/uploads-wiring.ts';

const STALE_TIME = new Date('2000-01-01T00:00:00.000Z');

function seedUploads(root: string, ids: string[]): string {
  const uploadsRoot = path.join(root, 'uploads');
  fs.mkdirSync(uploadsRoot, { recursive: true });
  for (const id of ids) {
    const entryDir = path.join(uploadsRoot, id);
    fs.mkdirSync(entryDir);
    fs.writeFileSync(path.join(entryDir, 'upload.bin'), 'x', 'utf8');
    fs.utimesSync(entryDir, STALE_TIME, STALE_TIME);
  }
  return uploadsRoot;
}

test('one prune pass snapshots the live session set once rather than rebuilding it per uploads directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-uploads-'));
  try {
    const uploadsRoot = seedUploads(root, ['aged-one', 'aged-two', 'aged-three', 'live-session']);
    let liveSessionIdsCalls = 0;
    const wiring = createUploadsWiring({
      configPath: path.join(root, 'config.json'),
      liveSessionIds: () => {
        liveSessionIdsCalls += 1;
        return new Set(['live-session']);
      },
    });

    await wiring.prune();

    assert.equal(liveSessionIdsCalls, 1);
    assert.deepEqual(fs.readdirSync(uploadsRoot), ['live-session']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second prune pass takes a fresh snapshot, so a session that ended is no longer retained', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-uploads-'));
  try {
    const uploadsRoot = seedUploads(root, ['ending-session']);
    let liveSessionIdsCalls = 0;
    const wiring = createUploadsWiring({
      configPath: path.join(root, 'config.json'),
      liveSessionIds: () => {
        liveSessionIdsCalls += 1;
        return new Set(liveSessionIdsCalls === 1 ? ['ending-session'] : []);
      },
    });

    await wiring.prune();
    assert.deepEqual(fs.readdirSync(uploadsRoot), ['ending-session']);

    await wiring.prune();

    assert.equal(liveSessionIdsCalls, 2);
    assert.deepEqual(fs.readdirSync(uploadsRoot), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
