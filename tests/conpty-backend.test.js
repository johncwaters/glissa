'use strict';

// Tests for the Windows console backend selection that fixes the per-prompt-send
// focus-steal (a grandchild console spawn under headless OS ConPTY raises the host
// terminal). Pure-helper tests pass `platform` explicitly so they run on any OS; the
// Session integration tests exercise start()'s real wiring and are win32-gated
// because start() reads process.platform directly.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session, buildPtyBackendOpts } = require('../sessions');
const { STATES } = require('../shared/states');

// ---------------------------------------------------------------------------
// buildPtyBackendOpts (pure, cross-platform)
// ---------------------------------------------------------------------------

test('win32 + dll -> useConptyDll:true (bundled ConPTY)', () => {
  assert.deepEqual(buildPtyBackendOpts({ platform: 'win32', conptyMode: 'dll' }), {
    useConptyDll: true,
  });
});

test('win32 + os-conpty -> {} (historical OS ConPTY, no flag)', () => {
  assert.deepEqual(buildPtyBackendOpts({ platform: 'win32', conptyMode: 'os-conpty' }), {});
});

test('win32 + winpty -> useConpty:false (legacy backend)', () => {
  assert.deepEqual(buildPtyBackendOpts({ platform: 'win32', conptyMode: 'winpty' }), {
    useConpty: false,
  });
});

test('win32 + default mode (omitted) -> useConptyDll:true', () => {
  assert.deepEqual(buildPtyBackendOpts({ platform: 'win32' }), { useConptyDll: true });
});

test('win32 + unknown mode -> {} (falls back to safe OS ConPTY)', () => {
  assert.deepEqual(buildPtyBackendOpts({ platform: 'win32', conptyMode: 'bogus' }), {});
});

test('non-win32 never carries a backend flag (linux, every mode)', () => {
  for (const conptyMode of ['dll', 'os-conpty', 'winpty', undefined]) {
    assert.deepEqual(buildPtyBackendOpts({ platform: 'linux', conptyMode }), {});
  }
});

test('non-win32 never carries a backend flag (darwin)', () => {
  assert.deepEqual(buildPtyBackendOpts({ platform: 'darwin', conptyMode: 'winpty' }), {});
});

// ---------------------------------------------------------------------------
// Session.start() backend wiring + dll load-failure fallback (win32)
// ---------------------------------------------------------------------------

function fakePty(pid = 2147483646) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

const WIN_ONLY = { skip: process.platform !== 'win32' };

test('start() passes useConptyDll:true by default on win32', WIN_ONLY, () => {
  const calls = [];
  const s = new Session({
    id: 'conpty-default',
    name: 'conpty-default',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args, opts) => { calls.push({ file, args, opts }); return fakePty(); },
  });
  try {
    s.start();
    assert.equal(calls.length, 1, 'spawned exactly once');
    assert.equal(calls[0].opts.useConptyDll, true, 'default backend is bundled ConPTY');
    assert.equal(s.state, STATES.STARTING);
  } finally {
    s.destroy();
  }
});

test('start() falls back to OS ConPTY when the bundled dll fails to load', WIN_ONLY, () => {
  const calls = [];
  const s = new Session({
    id: 'conpty-fallback',
    name: 'conpty-fallback',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (_file, _args, opts) => {
      calls.push({ opts });
      if (opts.useConptyDll) throw new Error('Could not load conpty.dll');
      return fakePty();
    },
  });
  try {
    s.start();
    assert.equal(calls.length, 2, 'one failed dll attempt, one OS-ConPTY retry');
    assert.equal(calls[0].opts.useConptyDll, true, 'first attempt used the dll backend');
    assert.equal(calls[1].opts.useConptyDll, undefined, 'retry dropped the dll flag');
    assert.equal(calls[1].opts.useConpty, undefined, 'retry is plain OS ConPTY, not winpty');
    assert.equal(s.state, STATES.STARTING, 'fallback spawn still reaches STARTING');
  } finally {
    s.destroy();
  }
});

test('start() surfaces spawn_fail when both dll and OS-ConPTY attempts throw', WIN_ONLY, () => {
  const calls = [];
  let errored = null;
  const s = new Session({
    id: 'conpty-hardfail',
    name: 'conpty-hardfail',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (_file, _args, opts) => { calls.push({ opts }); throw new Error('boom'); },
  });
  s.on('error', (e) => { errored = e; });
  try {
    s.start();
    assert.equal(calls.length, 2, 'dll attempt + one OS-ConPTY retry, both threw');
    assert.equal(s.state, STATES.FAILED, 'genuine spawn failure -> FAILED');
    assert.ok(errored, 'error event emitted');
  } finally {
    s.destroy();
  }
});

test('conptyMode:"winpty" passes useConpty:false and does not retry', WIN_ONLY, () => {
  const calls = [];
  const s = new Session({
    id: 'conpty-winpty',
    name: 'conpty-winpty',
    path: process.cwd(),
    conptyMode: 'winpty',
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (_file, _args, opts) => { calls.push({ opts }); return fakePty(); },
  });
  try {
    s.start();
    assert.equal(calls.length, 1, 'winpty has no dll-load fallback');
    assert.equal(calls[0].opts.useConpty, false);
    assert.equal(calls[0].opts.useConptyDll, undefined);
    assert.equal(s.state, STATES.STARTING);
  } finally {
    s.destroy();
  }
});
