import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createIntegrationRefWatcher } from '../detection/integration-ref-watch.ts';
import { SHORT_NAMES_AVAILABLE, shortPathOf } from './helpers/short-path.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeCommonGitDir(branches = ['develop']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-irw-'));
  const logsHeads = path.join(dir, 'logs', 'refs', 'heads');
  fs.mkdirSync(logsHeads, { recursive: true });
  for (const b of branches) {
    const p = path.join(logsHeads, b);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '0000 init\n', 'utf8');
  }
  const append = (b: string, line: string) => fs.appendFileSync(path.join(logsHeads, b), `${line}\n`, 'utf8');
  return { dir, append, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('fires (debounced, coalesced) when the integration branch reflog is appended', async () => {
  const fx = fakeCommonGitDir(['develop']);
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: fx.dir, branch: 'develop', onChange: () => { calls++; }, debounceMs: 50 });
  try {
    assert.equal(w.start(), true, 'started over a real reflog dir');
    assert.equal(w.active, true);

    for (let i = 0; i < 4; i++) fx.append('develop', `move ${i}`);
    await wait(300);
    assert.equal(calls, 1, 'the burst coalesced into exactly one onChange');

    fx.append('develop', 'later move');
    await wait(300);
    assert.equal(calls, 2, 'a subsequent move fires again');
  } finally {
    w.stop();
    fx.cleanup();
  }
});

test('ignores a sibling branch reflog (leaf filter)', async () => {
  const fx = fakeCommonGitDir(['develop', 'feature']);
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: fx.dir, branch: 'develop', onChange: () => { calls++; }, debounceMs: 50 });
  try {
    w.start();
    fx.append('feature', 'a sibling commit');
    await wait(250);
    assert.equal(calls, 0, 'a sibling branch move does not fire the integration watcher');
    fx.append('develop', 'our move');
    await wait(250);
    assert.equal(calls, 1, 'our branch move does fire');
  } finally {
    w.stop();
    fx.cleanup();
  }
});

test('handles a nested integration branch (release/x)', async () => {
  const fx = fakeCommonGitDir(['release/x']);
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: fx.dir, branch: 'release/x', onChange: () => { calls++; }, debounceMs: 50 });
  try {
    assert.equal(w.start(), true, 'watches the nested reflog parent dir');
    fx.append('release/x', 'move');
    await wait(250);
    assert.equal(calls, 1);
  } finally {
    w.stop();
    fx.cleanup();
  }
});

test('the watcher survives a commonGitDir under an 8.3 short parent', { skip: !SHORT_NAMES_AVAILABLE }, async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-irw-shortbase-'));
  const dir = shortPathOf(outer);
  assert.ok(dir, 'the volume mints an 8.3 alias');
  const logsHeads = path.join(dir, 'logs', 'refs', 'heads');
  fs.mkdirSync(logsHeads, { recursive: true });
  fs.writeFileSync(path.join(logsHeads, 'develop'), '0000 init\n', 'utf8');
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: dir, branch: 'develop', onChange: () => { calls++; }, debounceMs: 50 });
  try {
    assert.equal(w.start(), true, 'started over the short-path reflog dir');
    fs.appendFileSync(path.join(logsHeads, 'develop'), 'move\n', 'utf8');
    await wait(300);
    assert.equal(calls, 1, 'fires normally instead of aborting on the short-path prefix');
  } finally {
    w.stop();
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('start() declines when the reflog dir does not exist yet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-irw-none-'));
  const w = createIntegrationRefWatcher({ commonGitDir: dir, branch: 'develop', onChange: () => {}, debounceMs: 50 });
  try {
    assert.equal(w.start(), false, 'no logs/refs/heads dir -> start() declines, leans on the floor');
    assert.equal(w.active, false);
    assert.doesNotThrow(() => w.stop());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stop() halts the watcher and start() after stop stays inert', async () => {
  const fx = fakeCommonGitDir(['develop']);
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: fx.dir, branch: 'develop', onChange: () => { calls++; }, debounceMs: 50 });
  try {
    w.start();
    w.stop();
    assert.equal(w.active, false);
    fx.append('develop', 'after stop');
    await wait(250);
    assert.equal(calls, 0, 'no onChange after stop');
    assert.equal(w.start(), false, 'single-use: start() after stop stays inert');
  } finally {
    w.stop();
    fx.cleanup();
  }
});
