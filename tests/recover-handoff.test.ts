import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execFileAsync } from '../server/child-process-safe.ts';
import {
  PREVIOUS_DEPENDENCIES_BACKUP_NAME,
  PREVIOUS_DIST_BACKUP_NAME,
  QUARANTINED_DIST_NAME,
} from '../server/core/update-apply-core.ts';

const SCRIPT_PATH = path.join(import.meta.dirname, '..', 'scripts', 'recover-handoff.mjs');

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-recover-'));
}

function writeSentinel(directoryPath: string, text: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.writeFileSync(path.join(directoryPath, 'sentinel.txt'), text, 'utf8');
}

async function runRecovery(root: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [SCRIPT_PATH, root], { encoding: 'utf8' });
}

test('recover handoff restores missing node_modules', async () => {
  const root = makeRoot();
  try {
    writeSentinel(path.join(root, '.glissa', 'update', 'prev-node_modules'), 'dependencies');
    const execution = await runRecovery(root);
    assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'sentinel.txt'), 'utf8'), 'dependencies');
    assert.match(execution.stdout, /restored prev-node_modules to node_modules/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recover handoff restores missing dist', async () => {
  const root = makeRoot();
  try {
    writeSentinel(path.join(root, '.glissa', 'update', 'prev-dist'), 'bundle');
    const execution = await runRecovery(root);
    assert.equal(fs.readFileSync(path.join(root, 'dist', 'sentinel.txt'), 'utf8'), 'bundle');
    assert.match(execution.stdout, /restored prev-dist to dist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recover handoff honors restore marker entries and deletes the marker', async () => {
  const root = makeRoot();
  const updatePath = path.join(root, '.glissa', 'update');
  try {
    writeSentinel(path.join(updatePath, 'saved-dist'), 'saved');
    const markerPath = path.join(updatePath, 'restore.json');
    fs.writeFileSync(markerPath, JSON.stringify({ restore: [{ from: 'saved-dist', to: 'dist' }] }), 'utf8');
    await runRecovery(root);
    assert.equal(fs.readFileSync(path.join(root, 'dist', 'sentinel.txt'), 'utf8'), 'saved');
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recover handoff exits zero when there is nothing to do', async () => {
  const root = makeRoot();
  try {
    const execution = await runRecovery(root);
    assert.equal(execution.stdout, '');
    assert.equal(execution.stderr, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recover handoff never overwrites present targets', async () => {
  const root = makeRoot();
  const updatePath = path.join(root, '.glissa', 'update');
  try {
    writeSentinel(path.join(root, 'dist'), 'live-dist');
    writeSentinel(path.join(root, 'node_modules'), 'live-dependencies');
    writeSentinel(path.join(updatePath, 'prev-dist'), 'old-dist');
    writeSentinel(path.join(updatePath, 'prev-node_modules'), 'old-dependencies');
    await runRecovery(root);
    assert.equal(fs.readFileSync(path.join(root, 'dist', 'sentinel.txt'), 'utf8'), 'live-dist');
    assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'sentinel.txt'), 'utf8'), 'live-dependencies');
    assert.equal(fs.existsSync(path.join(updatePath, 'prev-dist')), true);
    assert.equal(fs.existsSync(path.join(updatePath, 'prev-node_modules')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a marker entry quarantines the live artifact it has to replace', async () => {
  const root = makeRoot();
  const updatePath = path.join(root, '.glissa', 'update');
  try {
    writeSentinel(path.join(root, 'dist'), 'half-swapped');
    writeSentinel(path.join(updatePath, PREVIOUS_DIST_BACKUP_NAME), 'known-good');
    fs.writeFileSync(
      path.join(updatePath, 'restore.json'),
      JSON.stringify({ restore: [{ from: PREVIOUS_DIST_BACKUP_NAME, to: 'dist' }] }),
      'utf8',
    );
    await runRecovery(root);
    assert.equal(fs.readFileSync(path.join(root, 'dist', 'sentinel.txt'), 'utf8'), 'known-good');
    assert.equal(fs.readFileSync(path.join(updatePath, QUARANTINED_DIST_NAME, 'sentinel.txt'), 'utf8'), 'half-swapped');
    assert.equal(fs.existsSync(path.join(updatePath, 'restore.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a marker entry that cannot be applied keeps the marker for the next start', async () => {
  const root = makeRoot();
  const updatePath = path.join(root, '.glissa', 'update');
  try {
    fs.mkdirSync(updatePath, { recursive: true });
    const markerPath = path.join(updatePath, 'restore.json');
    fs.writeFileSync(markerPath, JSON.stringify({ restore: [{ from: PREVIOUS_DIST_BACKUP_NAME, to: 'dist' }] }), 'utf8');
    const execution = await runRecovery(root);
    assert.equal(fs.existsSync(markerPath), true);
    assert.match(execution.stdout, /could not restore prev-dist to dist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function backupNameDeclaredInShim(source: string, constantName: string): string {
  const declaration = new RegExp(`const ${constantName} = '([^']+)';`).exec(source);
  assert.ok(declaration, `the shim declares ${constantName}`);
  return declaration[1];
}

test('the recovery shim restores exactly the backup names the handoff plan writes', () => {
  const shimSource = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.equal(backupNameDeclaredInShim(shimSource, 'PREVIOUS_DIST_BACKUP_NAME'), PREVIOUS_DIST_BACKUP_NAME);
  assert.equal(backupNameDeclaredInShim(shimSource, 'PREVIOUS_DEPENDENCIES_BACKUP_NAME'), PREVIOUS_DEPENDENCIES_BACKUP_NAME);
  assert.match(shimSource, /restore\(updatePath, root, PREVIOUS_DEPENDENCIES_BACKUP_NAME, 'node_modules'\)/);
  assert.match(shimSource, /restore\(updatePath, root, PREVIOUS_DIST_BACKUP_NAME, 'dist'\)/);
});
