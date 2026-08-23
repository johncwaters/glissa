'use strict';

// The Mill IO shell against a real temp pack tree: what a malformed spec file costs, how a request
// landing mid-pass is answered, and that no server path reaches the wire.
//
// Everything is a temp fixture injected through createMillWiring, so nothing here reads the operator's
// real packs/ or ~/.glissa, and no backend is booted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMillWiring } = require('../server/mill-wiring');

const VERSION = 'e'.repeat(64);

function writeSpec(specsDir, name, body) {
  fs.writeFileSync(path.join(specsDir, `${name}.pack.json`), body, 'utf8');
}

function writeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-mill-wiring-'));
  const packsDir = path.join(tmpDir, 'packs');
  const specsDir = path.join(packsDir, 'specs');
  const sourcesDir = path.join(packsDir, 'sources', 'good');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, 'notes.md'), '# notes\n', 'utf8');
  writeSpec(specsDir, 'good', JSON.stringify({
    name: 'good',
    description: 'A pack that builds',
    sources: [{ path: 'sources/good' }],
    budgetTokens: 8000,
  }));

  const builtRoot = path.join(tmpDir, 'built');
  const currentDir = path.join(builtRoot, 'good', 'current');
  fs.mkdirSync(currentDir, { recursive: true });
  fs.writeFileSync(path.join(currentDir, 'manifest.json'), JSON.stringify({
    name: 'good',
    version: VERSION,
    builtAt: '2026-08-20T10:00:00.000Z',
    tokenEstimate: 4000,
    budgetTokens: 8000,
    indexTokenEstimate: 200,
    rules: [],
    sources: [{ pattern: 'sources/good', files: [{ relPath: 'sources/good/notes.md' }] }],
    skills: [],
    outputs: [{ relPath: 'CLAUDE.md', tokenEstimate: 200 }],
  }), 'utf8');

  return { tmpDir, packsDir, specsDir, builtRoot };
}

function makeWiring(fixture, overrides = {}) {
  let clock = 1000;
  const passes = { count: 0 };
  const wiring = createMillWiring({
    config: {},
    baseDir: fixture.packsDir,
    specsDir: fixture.specsDir,
    builtRoot: fixture.builtRoot,
    // One call per assembled report, which is what makes a pass countable from outside.
    now: () => {
      passes.count += 1;
      clock += 1;
      return clock;
    },
    log: { warn: () => {} },
    ...overrides,
  });
  return { wiring, passes };
}

function pull(wiring, requestId) {
  const replies = [];
  const done = wiring.requestReport({ requestId }, (msg) => replies.push(msg));
  return { replies, done };
}

test('a spec file whose JSON is not an object costs that pack row and nothing else', async (t) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));
  // Valid JSON, so the parse does not throw; every read of spec.sources / spec.distill below would.
  writeSpec(fixture.specsDir, 'nullspec', 'null');
  writeSpec(fixture.specsDir, 'arrayspec', '[]');

  const { wiring } = makeWiring(fixture);
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const report = replies[0];
  assert.equal(report.type, 'mill-report');
  assert.equal(report.error, null, 'one malformed spec must not turn the whole report into an error');
  assert.equal(report.totals.packCount, 3);
  assert.equal(report.totals.invalidSpecs, 2);

  for (const name of ['nullspec', 'arrayspec']) {
    const row = report.packs.find((pack) => pack.name === name);
    assert.equal(row.specValid, false, `${name} is invalid`);
    assert.deepEqual(row.specErrors, ['spec file is not a JSON object']);
    assert.equal(row.built, null);
    assert.deepEqual(row.distill, []);
  }

  const good = report.packs.find((pack) => pack.name === 'good');
  assert.equal(good.specValid, true);
  assert.equal(good.built.version, VERSION);
});

test('a spec file that is not JSON at all reports the failure without the path it failed on', async (t) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));
  writeSpec(fixture.specsDir, 'broken', '{ not json');

  const { wiring } = makeWiring(fixture);
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const broken = replies[0].packs.find((pack) => pack.name === 'broken');
  assert.equal(broken.specValid, false);
  assert.ok(broken.specErrors[0].startsWith('could not read spec:'));
  assert.ok(!JSON.stringify(replies[0]).includes(fixture.tmpDir), 'no server path reaches the wire');
});

test('an unbuilt pack reports a short reason, not the built root it looked in', async (t) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));
  fs.rmSync(path.join(fixture.builtRoot, 'good'), { recursive: true, force: true });

  const { wiring } = makeWiring(fixture);
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const good = replies[0].packs.find((pack) => pack.name === 'good');
  assert.equal(good.built, null);
  assert.equal(good.builtReason, 'not built');
  assert.ok(!JSON.stringify(replies[0]).includes(fixture.tmpDir));
});

test('a manifest that is present but unreadable reports so without naming the directory', async (t) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.builtRoot, 'good', 'current', 'manifest.json'), '{ broken', 'utf8');

  const { wiring } = makeWiring(fixture);
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const good = replies[0].packs.find((pack) => pack.name === 'good');
  assert.equal(good.built, null);
  assert.equal(good.builtReason, 'manifest missing or unreadable');
  assert.ok(!JSON.stringify(replies[0]).includes(fixture.tmpDir));
});

test('one request runs exactly one pass', async (t) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const { wiring, passes } = makeWiring(fixture);
  const { done } = pull(wiring, 'r1');
  await done;
  assert.equal(passes.count, 1);
});

test('a request landing mid-pass is answered from a pass that started after it arrived', async (t) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const { wiring, passes } = makeWiring(fixture);
  // Started synchronously back to back, so the second lands while the first pass is still in its fs
  // walk: that is the case where sharing the first pass would answer it from bytes read before it asked.
  const first = pull(wiring, 'r1');
  const second = pull(wiring, 'r2');
  await Promise.all([first.done, second.done]);

  assert.equal(passes.count, 2, 'the late request earned a follow-up pass');
  assert.equal(first.replies[0].requestId, 'r1');
  assert.equal(second.replies[0].requestId, 'r2');
  assert.equal(first.replies[0].ts, second.replies[0].ts, 'both are answered from the same, later pass');
  assert.equal(second.replies[0].ts, 1002, 'the answer comes from the second pass, not the first');
});

test('the follow-up is bounded at one, so a polling client cannot chain passes forever', async (t) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const { wiring, passes } = makeWiring(fixture);
  const pulls = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => pull(wiring, id));
  await Promise.all(pulls.map((entry) => entry.done));
  assert.equal(passes.count, 2, 'four late requests still cost one follow-up, not four');
});

test('the cached report carries no requestId, so a connect replay answers nobody in particular', async (t) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const { wiring } = makeWiring(fixture);
  assert.equal(wiring.getCachedReport(), null, 'nothing is cached before the first pull');
  const { done } = pull(wiring, 'r1');
  await done;
  assert.equal(wiring.getCachedReport().requestId, null);
  assert.equal(wiring.getCachedReport().totals.packCount, 1);
});
