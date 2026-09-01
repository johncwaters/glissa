// The Mill IO shell against a real temp pack tree: what a malformed spec file costs, how a request
// landing mid-pass is answered, and that no server path reaches the wire.
//
// Everything is a temp fixture injected through createMillWiring, so nothing here reads the operator's
// real packs/ or ~/.glissa, and no backend is booted.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { createMillWiring } from '../server/mill-wiring.ts';
import type { MillReportPayload, MillWiring, MillWiringDependencies } from '../server/mill-wiring.ts';
import type { MillPackRow, MillReport } from '../server/core/mill-core.ts';
import { projectVariantSlug } from '../server/core/pack-core.ts';

const VERSION = 'e'.repeat(64);

interface Fixture {
  tmpDir: string;
  packsDir: string;
  specsDir: string;
  builtRoot: string;
  versionDir: string;
}

interface Pull {
  replies: MillReportPayload[];
  done: Promise<void>;
}

function writeSpec(specsDir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(specsDir, `${name}.pack.json`), body, 'utf8');
}

function writeFixture(): Fixture {
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
  const versionDir = path.join(builtRoot, 'good', 'versions', VERSION);
  fs.mkdirSync(currentDir, { recursive: true });
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(currentDir, 'version'), `${VERSION}\n`, 'utf8');
  fs.writeFileSync(path.join(versionDir, 'manifest.json'), JSON.stringify({
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

  return { tmpDir, packsDir, specsDir, builtRoot, versionDir };
}

function makeWiring(fixture: Fixture, overrides: Partial<MillWiringDependencies> = {}): {
  wiring: MillWiring;
  passes: { count: number };
} {
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

function pull(wiring: MillWiring, requestId: string): Pull {
  const replies: MillReportPayload[] = [];
  const done = wiring.requestReport({ requestId }, (payload) => replies.push(payload));
  return { replies, done };
}

// A failed pass answers the requestId with a reason instead of a report; every case here expects the
// report, so the failure shape is refused once rather than at each read.
function reportOf(payload: MillReportPayload | undefined): MillReport {
  if (!payload) throw new Error('the request went unanswered');
  if (payload.error !== null) throw new Error(`the mill pass failed: ${payload.error}`);
  return payload;
}

function packRow(report: MillReport, name: string): MillPackRow {
  const row = report.packs.find((pack) => pack.name === name);
  if (!row) throw new Error(`the report carries no row for ${name}`);
  return row;
}

test('a spec file whose JSON is not an object costs that pack row and nothing else', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));
  // Valid JSON, so the parse does not throw; every read of spec.sources / spec.distill below would.
  writeSpec(fixture.specsDir, 'nullspec', 'null');
  writeSpec(fixture.specsDir, 'arrayspec', '[]');

  const { wiring } = makeWiring(fixture);
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const report = reportOf(replies[0]);
  assert.equal(report.type, 'mill-report');
  assert.equal(report.error, null, 'one malformed spec must not turn the whole report into an error');
  assert.equal(report.totals.packCount, 3);
  assert.equal(report.totals.invalidSpecs, 2);

  for (const name of ['nullspec', 'arrayspec']) {
    const row = packRow(report, name);
    assert.equal(row.specValid, false, `${name} is invalid`);
    assert.deepEqual(row.specErrors, ['spec file is not a JSON object']);
    assert.equal(row.built, null);
    assert.deepEqual(row.distill, []);
  }

  const good = packRow(report, 'good');
  assert.equal(good.specValid, true);
  assert.equal(good.built?.version, VERSION);
});

test('a spec file that is not JSON at all reports the failure without the path it failed on', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));
  writeSpec(fixture.specsDir, 'broken', '{ not json');

  const { wiring } = makeWiring(fixture);
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const report = reportOf(replies[0]);
  const broken = packRow(report, 'broken');
  assert.equal(broken.specValid, false);
  assert.ok(broken.specErrors[0].startsWith('could not read spec:'));
  assert.ok(!JSON.stringify(report).includes(fixture.tmpDir), 'no server path reaches the wire');
});

test('an unbuilt pack reports a short reason, not the built root it looked in', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));
  fs.rmSync(path.join(fixture.builtRoot, 'good'), { recursive: true, force: true });

  const { wiring } = makeWiring(fixture);
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const report = reportOf(replies[0]);
  const good = packRow(report, 'good');
  assert.equal(good.built, null);
  assert.equal(good.builtReason, 'not built');
  assert.ok(!JSON.stringify(report).includes(fixture.tmpDir));
});

test('a manifest that is present but unreadable reports so without naming the directory', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.versionDir, 'manifest.json'), '{ broken', 'utf8');

  const { wiring } = makeWiring(fixture);
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const report = reportOf(replies[0]);
  const good = packRow(report, 'good');
  assert.equal(good.built, null);
  assert.equal(good.builtReason, 'manifest missing or unreadable');
  assert.ok(!JSON.stringify(report).includes(fixture.tmpDir));
});

test('one request runs exactly one pass', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const { wiring, passes } = makeWiring(fixture);
  const { done } = pull(wiring, 'r1');
  await done;
  assert.equal(passes.count, 1);
});

test('a request landing mid-pass is answered from a pass that started after it arrived', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const { wiring, passes } = makeWiring(fixture);
  // Started synchronously back to back, so the second lands while the first pass is still in its fs
  // walk: that is the case where sharing the first pass would answer it from bytes read before it asked.
  const first = pull(wiring, 'r1');
  const second = pull(wiring, 'r2');
  await Promise.all([first.done, second.done]);

  assert.equal(passes.count, 2, 'the late request earned a follow-up pass');
  const firstReport = reportOf(first.replies[0]);
  const secondReport = reportOf(second.replies[0]);
  assert.equal(firstReport.requestId, 'r1');
  assert.equal(secondReport.requestId, 'r2');
  assert.equal(firstReport.ts, secondReport.ts, 'both are answered from the same, later pass');
  assert.equal(secondReport.ts, 1002, 'the answer comes from the second pass, not the first');
});

test('the follow-up is bounded at one, so a polling client cannot chain passes forever', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const { wiring, passes } = makeWiring(fixture);
  const pulls = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => pull(wiring, id));
  await Promise.all(pulls.map((entry) => entry.done));
  assert.equal(passes.count, 2, 'four late requests still cost one follow-up, not four');
});

test('the cached report carries no requestId, so a connect replay answers nobody in particular', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const { wiring } = makeWiring(fixture);
  assert.equal(wiring.getCachedReport(), null, 'nothing is cached before the first pull');
  const { done } = pull(wiring, 'r1');
  await done;
  const cached = wiring.getCachedReport();
  assert.equal(cached?.requestId, null);
  assert.equal(cached?.totals.packCount, 1);
});

test('listPackNames reports every spec on disk, including one that has never been built', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));
  writeSpec(fixture.specsDir, 'unbuilt', JSON.stringify({
    name: 'unbuilt', sources: [{ path: 'sources/good' }], budgetTokens: 8000,
  }));

  const { wiring } = makeWiring(fixture);
  // A first assignment is exactly what makes the mill build a pack, so validating against BUILT packs
  // would refuse every pack it is worth assigning.
  assert.deepEqual((await wiring.listPackNames()).sort(), ['good', 'unbuilt']);
});

test('the report carries the project ids the assignment control addresses', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const { wiring } = makeWiring(fixture, {
    config: { projects: [{ id: 'p1', name: 'glissa', packs: ['good'] }, { id: 'p2', name: 'other' }] },
  });
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const report = reportOf(replies[0]);
  assert.deepEqual(report.projects, [
    { id: 'p1', name: 'glissa', packs: ['good'] },
    { id: 'p2', name: 'other', packs: [] },
  ]);
  assert.equal(report.packs[0].hasConsumers, true);
});

test('the report carries the injected measurement for its named pack', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));
  const measurement = { deliveries: 2, measurableDeliveries: 1, openRate: 1 };
  const { wiring } = makeWiring(fixture, { measurement: () => ({ good: measurement }) });

  const { replies, done } = pull(wiring, 'r1');
  await done;

  assert.strictEqual(packRow(reportOf(replies[0]), 'good').measurement, measurement);
});

test('two cards on one checkout are offered once, and deliver as one project', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const projectPath = path.join(fixture.tmpDir, 'checkout');
  const { wiring } = makeWiring(fixture, {
    config: {
      projects: [
        { id: 'p1', name: 'glissa', path: projectPath, packs: ['good'] },
        { id: 'p2', name: 'glissa (2)', path: projectPath, packs: ['good'] },
      ],
    },
    // The snapshot shape the Session class hands over, path included: it is what groups the rows.
    listSessions: () => [
      { id: 's1', name: 'glissa', path: projectPath, state: 'RUNNING', packs: [{ name: 'good', version: VERSION }] },
      { id: 's2', name: 'glissa (2)', path: projectPath, state: 'RUNNING', packs: [{ name: 'good', version: VERSION }] },
    ],
  });
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const report = reportOf(replies[0]);
  assert.deepEqual(report.projects, [{ id: 'p1', name: 'glissa', packs: ['good'] }]);
  const good = packRow(report, 'good');
  assert.equal(good.deliveredTo.length, 1);
  assert.equal(good.deliveredTo[0].project, 'glissa');
  assert.equal(good.deliveredTo[0].sessionCount, 2);
  assert.ok(!JSON.stringify(report).includes(fixture.tmpDir), 'no server path reaches the wire');
});

test('a dormant card with an assigned pack reports a pending delivery, not silence', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const projectPath = path.join(fixture.tmpDir, 'checkout');
  const { wiring } = makeWiring(fixture, {
    config: { projects: [{ id: 'p1', name: 'glissa', path: projectPath, packs: ['good'] }] },
    listSessions: () => [
      { id: 's1', name: 'glissa', path: projectPath, state: 'DORMANT', packs: [] },
    ],
  });
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const good = packRow(reportOf(replies[0]), 'good');
  assert.equal(good.deliveredTo.length, 1);
  assert.equal(good.deliveredTo[0]?.pending, true);
  assert.equal(good.deliveredTo[0]?.project, 'glissa');
  assert.equal(good.deliveredTo[0]?.state, 'DORMANT');
  assert.ok(!JSON.stringify(replies[0]).includes(fixture.tmpDir), 'no server path reaches the wire');
});

test('a spec no project and no lane names is reported as having no consumers', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));

  const { wiring } = makeWiring(fixture, { config: { projects: [{ id: 'p1', name: 'glissa' }] } });
  const { replies, done } = pull(wiring, 'r1');
  await done;

  const report = reportOf(replies[0]);
  assert.equal(report.packs[0].hasConsumers, false);
  assert.equal(report.totals.unconsumed, 1);
});

// ---- Per-project variants: the shell enumerates a group's derived packs beside it ----

function writeVariantFixture(): Fixture {
  const fixture = writeFixture();
  writeSpec(fixture.specsDir, 'memory', JSON.stringify({
    name: 'memory',
    description: 'Recorded observation',
    perProjectVariants: true,
    sources: [
      { path: 'sources/good', data: true },
      { path: 'sources/good/projects/{{projectSlug}}.md', data: true, optional: true },
    ],
    budgetTokens: 8000,
  }));
  return fixture;
}

function variantConfig() {
  return { projects: [{ id: 'p1', name: 'glissa', path: '/repos/a/glissa', packs: ['memory'] }] };
}

test('a group spec reports its base row plus one row per consuming project', async () => {
  const fixture = writeVariantFixture();
  const slug = projectVariantSlug('/repos/a/glissa');
  try {
    const { wiring } = makeWiring(fixture, { config: variantConfig() });
    const { replies, done } = pull(wiring, 'r1');
    await done;

    const report = reportOf(replies[0]);
    assert.deepEqual(report.packs.map((pack) => pack.name), ['good', 'memory', `memory-${slug}`]);
    const variant = packRow(report, `memory-${slug}`);
    assert.equal(variant.group, 'memory');
    assert.equal(variant.projectId, 'p1');
    // Never built yet, which is a plain "not built" like any other pack, with no server path on the wire.
    assert.equal(variant.built, null);
    assert.equal(variant.builtReason, 'not built');
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
});

test('a group with no consuming project reports only its base row', async () => {
  const fixture = writeVariantFixture();
  try {
    const { wiring } = makeWiring(fixture, { config: { projects: [] } });
    const { replies, done } = pull(wiring, 'r1');
    await done;

    const report = reportOf(replies[0]);
    assert.deepEqual(report.packs.map((pack) => pack.name), ['good', 'memory']);
    assert.equal(report.totals.variantCount, 0);
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
});

test('a group name is what a project may be assigned; a variant name is not offered', async () => {
  const fixture = writeVariantFixture();
  try {
    const { wiring } = makeWiring(fixture, { config: variantConfig() });
    assert.deepEqual(await wiring.listPackNames(), ['good', 'memory']);
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
});

test('resolvePackSourceRoots answers from the SPEC, so an unbuilt pack is still judged', async (t: TestContext) => {
  const fixture = writeFixture();
  t.after(() => fs.rmSync(fixture.tmpDir, { recursive: true, force: true }));
  writeSpec(fixture.specsDir, 'mirror', JSON.stringify({
    name: 'mirror',
    description: 'never built',
    sources: [{ path: 'sources/good' }],
    distill: [{ output: 'sources/good/derived/brief.md', sources: [{ path: '../AGENTS.md' }], instructions: 'summarize' }],
    budgetTokens: 8000,
  }));

  const { wiring } = makeWiring(fixture);
  const roots = await wiring.resolvePackSourceRoots('mirror');
  const relative = roots.map((root) => path.relative(fixture.packsDir, root).replace(/\\/g, '/')).sort();
  assert.deepEqual(relative, ['../AGENTS.md', 'sources/good']);
  assert.deepEqual(await wiring.resolvePackSourceRoots('no-such-pack'), []);
});
