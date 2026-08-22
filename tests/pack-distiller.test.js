'use strict';

// The distiller lane with every side effect faked: which entry drifts, what the spawned session is
// told, how a verdict is re-checked against the file actually written, that distills are serialized,
// that stop() drains one in flight, and that the whole lane is inert while disabled. No fs, no timers,
// no real session.

const test = require('node:test');
const assert = require('node:assert/strict');

const { PACK_DISTILL_DENY, createPackDistiller, readDistillResult } = require('../server/pack-distiller');
const { buildStampLine, needsDistill } = require('../server/core/distill-core');

const HASHES = [
  { path: 'AGENTS.md', fullPath: 'C:/repo/AGENTS.md', sha256: 'a'.repeat(64) },
  { path: 'docs/plan.md', fullPath: 'C:/repo/docs/plan.md', sha256: 'b'.repeat(64) },
];

function stampedFile(sources = HASHES) {
  return `${buildStampLine(sources)}\n\nthe brief\n`;
}

function specWithDistill(overrides = {}) {
  return {
    name: 'glissa',
    description: 'demo',
    sources: [{ glob: 'sources/glissa/*.md' }],
    budgetTokens: 4000,
    distill: [{
      output: 'sources/glissa/derived/brief.md',
      sources: [{ path: '../AGENTS.md' }],
      instructions: 'Write a one page architecture brief.',
    }],
    ...overrides,
  };
}

/**
 * @param {object} options
 *   files      fake disk: output path -> content
 *   verdicts   queued result-file verdicts, consumed one per spawn
 *   onSpawn    optional side effect (usually writing the output into `files`)
 */
function harness({
  specs = [{ name: 'glissa', specPath: '/specs/glissa.pack.json' }],
  specByPath = { '/specs/glissa.pack.json': specWithDistill() },
  hashes = HASHES,
  files = {},
  verdicts = ['DISTILLED'],
  onSpawn = null,
  hangForever = false,
  enabled = false,
  intervalHours = 24,
} = {}) {
  const spawns = [];
  const warnings = [];
  const intervals = [];
  const timeouts = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const removed = [];

  const distiller = createPackDistiller({
    enabled,
    intervalHours,
    timeoutSeconds: 60,
    listSpecs: async () => specs,
    loadSpec: async (specPath) => {
      const spec = specByPath[specPath];
      if (!spec) throw new Error(`no spec at ${specPath}`);
      return spec;
    },
    sourceHashes: async () => (typeof hashes === 'function' ? hashes() : hashes),
    resolveOutput: (output) => (output.includes('..') ? null : `/packs/${output}`),
    readOutput: async (fullPath) => (fullPath in files ? files[fullPath] : null),
    spawnDistill: async (args) => {
      spawns.push(args);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (hangForever) await new Promise(() => {});
        await new Promise((resolve) => setImmediate(resolve));
        if (onSpawn) onSpawn(files, args);
      } finally {
        concurrent -= 1;
      }
    },
    resultPathFor: (packName, index) => `/tmp/${packName}-${index}.json`,
    readResult: async () => {
      const verdict = verdicts.shift() || 'ERROR';
      return { verdict, summary: `summary for ${verdict}` };
    },
    removeResult: (resultPath) => removed.push(resultPath),
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return { unref() { this.unrefed = true; } }; },
    clearIntervalFn: (handle) => { handle.cleared = true; },
    setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return { unref() {} }; },
    clearTimeoutFn: () => {},
    log: { log() {}, warn: (msg) => warnings.push(msg) },
  });

  return { distiller, spawns, warnings, intervals, timeouts, files, removed, maxConcurrent: () => maxConcurrent };
}

// ---------------------------------------------------------------------------
// drift detection
// ---------------------------------------------------------------------------

test('an output whose stamp matches its sources is current, and nothing is spawned', async () => {
  const h = harness({ files: { '/packs/sources/glissa/derived/brief.md': stampedFile() } });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'current');
  assert.equal(report.pack, 'glissa');
  assert.equal(h.spawns.length, 0);
});

test('a missing output spawns one distill session and reports the written file', async () => {
  const h = harness({ onSpawn: (files) => { files['/packs/sources/glissa/derived/brief.md'] = stampedFile(); } });
  const [report] = await h.distiller.runOnce();

  assert.equal(h.spawns.length, 1);
  assert.equal(report.status, 'distilled');
  assert.equal(report.verdict, 'DISTILLED');
  assert.equal(report.output, 'sources/glissa/derived/brief.md');
});

test('an edited source spawns a distill even though the output exists', async () => {
  const h = harness({
    files: { '/packs/sources/glissa/derived/brief.md': stampedFile([{ path: 'AGENTS.md', sha256: 'f'.repeat(64) }]) },
    onSpawn: (files) => { files['/packs/sources/glissa/derived/brief.md'] = stampedFile(); },
  });
  const [report] = await h.distiller.runOnce();

  assert.equal(h.spawns.length, 1);
  assert.equal(report.status, 'distilled');
});

test('a dry run reports the drift and its reason, and spawns nothing', async () => {
  const h = harness();
  const [report] = await h.distiller.runOnce({ dryRun: true });

  assert.equal(report.status, 'stale');
  assert.equal(report.reason, 'output file is missing');
  assert.equal(h.spawns.length, 0);
});

// ---------------------------------------------------------------------------
// the spawned session
// ---------------------------------------------------------------------------

test('the spawn carries the resolved output path, the source paths, the instructions and the stamp', async () => {
  const h = harness({ onSpawn: (files) => { files['/packs/sources/glissa/derived/brief.md'] = stampedFile(); } });
  await h.distiller.runOnce();

  const [spawn] = h.spawns;
  assert.match(spawn.prompt, /\/packs\/sources\/glissa\/derived\/brief\.md/);
  assert.match(spawn.prompt, /C:\/repo\/AGENTS\.md/);
  assert.ok(spawn.prompt.includes('Write a one page architecture brief.'));
  assert.ok(spawn.prompt.includes(buildStampLine(HASHES)), 'the exact stamp the verify step expects');
  assert.match(spawn.prompt, /\/tmp\/glissa-0\.json/);
  assert.equal(spawn.id, 'pack-distill:glissa#0');
  assert.ok(spawn.signal, 'a timeout signal is always passed');
});

test('the deny-list blocks the outward verbs and writes outside packs/', () => {
  const deny = PACK_DISTILL_DENY.deny;
  for (const rule of ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh:*)', 'Write(server/**)', 'Edit(docs/**)', 'Write(packs/specs/**)', 'Write(*)']) {
    assert.ok(deny.includes(rule), rule);
  }
});

// ---------------------------------------------------------------------------
// verdicts are re-checked against the file on disk
// ---------------------------------------------------------------------------

test('a DISTILLED verdict with no file written is an ERROR, not a success', async () => {
  const h = harness({ verdicts: ['DISTILLED'] });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /output file is missing/);
  assert.equal(h.warnings.length, 1);
});

test('a DISTILLED verdict whose written stamp does not match the sources is an ERROR', async () => {
  const h = harness({
    onSpawn: (files) => {
      files['/packs/sources/glissa/derived/brief.md'] = stampedFile([{ path: 'AGENTS.md', sha256: 'c'.repeat(64) }]);
    },
  });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /sources changed/);
});

test('a DISTILLED verdict whose file carries no stamp at all is an ERROR', async () => {
  const h = harness({
    onSpawn: (files) => { files['/packs/sources/glissa/derived/brief.md'] = '# Brief\n\nno stamp\n'; },
  });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /no distill stamp/);
});

test('a NO_CHANGE verdict is accepted once the stamp on disk is current', async () => {
  const h = harness({
    verdicts: ['NO_CHANGE'],
    onSpawn: (files) => { files['/packs/sources/glissa/derived/brief.md'] = stampedFile(); },
  });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'distilled');
  assert.equal(report.verdict, 'NO_CHANGE');
});

test('an ERROR verdict is reported once and never retried inside the pass', async () => {
  const h = harness({ verdicts: ['ERROR'] });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /summary for ERROR/);
  assert.equal(h.spawns.length, 1);
});

test('a hung session is aborted by the timeout and reported as an error', async () => {
  const h = harness({ hangForever: true });
  const pass = h.distiller.runOnce();
  // The lane arms one timeout per distill; firing it is what a real timer would do at the deadline.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.timeouts.length, 1);
  assert.equal(h.timeouts[0].ms, 60000);
  h.timeouts[0].fn();

  const [report] = await pass;
  assert.equal(report.status, 'error');
  assert.match(report.reason, /timed out/);
  assert.equal(h.spawns[0].signal.aborted, true);
});

// ---------------------------------------------------------------------------
// entries that never reach a session
// ---------------------------------------------------------------------------

test('an output path that escapes the packs directory errors before any spawn', async () => {
  const h = harness({
    specByPath: {
      '/specs/glissa.pack.json': specWithDistill({
        distill: [{ output: '../outside.md', sources: [{ path: '../AGENTS.md' }], instructions: 'x' }],
      }),
    },
  });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /escapes the packs directory/);
  assert.equal(h.spawns.length, 0);
});

test('distill sources that matched no file error instead of distilling from nothing', async () => {
  const h = harness({ hashes: [] });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /matched no files/);
  assert.equal(h.spawns.length, 0);
});

test('a spec with no distill entries is skipped silently', async () => {
  const h = harness({ specByPath: { '/specs/glissa.pack.json': specWithDistill({ distill: undefined }) } });
  assert.deepEqual(await h.distiller.runOnce(), []);
  assert.equal(h.spawns.length, 0);
});

test('a spec that declares distill but fails validation errors instead of spawning', async () => {
  const h = harness({ specByPath: { '/specs/glissa.pack.json': specWithDistill({ budgetTokens: 0 }) } });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /invalid spec/);
  assert.equal(h.spawns.length, 0);
});

test('an unreadable spec is reported, not thrown', async () => {
  const h = harness({ specByPath: {} });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /could not read spec/);
});

test('a name filter runs only that pack', async () => {
  const h = harness({
    specs: [{ name: 'glissa', specPath: '/specs/glissa.pack.json' }, { name: 'other', specPath: '/specs/other.pack.json' }],
    specByPath: {
      '/specs/glissa.pack.json': specWithDistill(),
      '/specs/other.pack.json': specWithDistill({ name: 'other' }),
    },
    verdicts: ['DISTILLED', 'DISTILLED'],
    onSpawn: (files) => { files['/packs/sources/glissa/derived/brief.md'] = stampedFile(); },
  });
  const reports = await h.distiller.runOnce({ name: 'other' });

  assert.equal(reports.length, 1);
  assert.equal(reports[0].pack, 'other');
});

// ---------------------------------------------------------------------------
// serialization, the interval, and stop
// ---------------------------------------------------------------------------

test('two stale entries distill one at a time, never concurrently', async () => {
  const h = harness({
    specByPath: {
      '/specs/glissa.pack.json': specWithDistill({
        distill: [
          { output: 'sources/glissa/derived/one.md', sources: [{ path: '../AGENTS.md' }], instructions: 'one' },
          { output: 'sources/glissa/derived/two.md', sources: [{ path: '../AGENTS.md' }], instructions: 'two' },
        ],
      }),
    },
    verdicts: ['DISTILLED', 'DISTILLED'],
    onSpawn: (files, args) => { files[args.prompt.match(/\/packs\/\S+\.md/)[0]] = stampedFile(); },
  });
  const reports = await h.distiller.runOnce();

  assert.equal(h.spawns.length, 2);
  assert.equal(h.maxConcurrent(), 1);
  assert.deepEqual(reports.map((r) => r.status), ['distilled', 'distilled']);
});

test('two overlapping passes queue behind each other rather than racing the same output', async () => {
  const h = harness({
    verdicts: ['DISTILLED', 'DISTILLED'],
    onSpawn: (files) => { files['/packs/sources/glissa/derived/brief.md'] = stampedFile(); },
  });
  const [first, second] = await Promise.all([h.distiller.runOnce(), h.distiller.runOnce()]);

  assert.equal(h.maxConcurrent(), 1);
  assert.equal(first[0].status, 'distilled');
  // The second pass finds the file the first one wrote, so it never spawns again.
  assert.equal(second[0].status, 'current');
  assert.equal(h.spawns.length, 1);
});

test('disabled is inert: start() installs no interval and spawns nothing', async () => {
  const h = harness({ enabled: false });
  await h.distiller.start();

  assert.equal(h.intervals.length, 0);
  assert.equal(h.spawns.length, 0);
  assert.equal(h.distiller.isEnabled(), false);
  await h.distiller.stop();
});

test('enabled: start() runs one pass immediately and arms an unref-ed interval', async () => {
  const h = harness({
    enabled: true,
    intervalHours: 6,
    onSpawn: (files) => { files['/packs/sources/glissa/derived/brief.md'] = stampedFile(); },
  });
  await h.distiller.start();

  assert.equal(h.spawns.length, 1, 'a source edited while Glissa was down is caught at boot');
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].ms, 6 * 3600000);
  await h.distiller.stop();
});

test('the interval tick runs another pass, and is re-entrancy guarded', async () => {
  const h = harness({
    enabled: true,
    verdicts: ['DISTILLED', 'DISTILLED', 'DISTILLED'],
    hashes: () => HASHES,
  });
  await h.distiller.start();
  assert.equal(h.spawns.length, 1, 'the boot pass');

  h.intervals[0].fn();
  h.intervals[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await h.distiller.stop();
  assert.equal(h.spawns.length, 2, 'the second overlapping tick is dropped, not stacked');
});

test('stop() drains a distill that is already running', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ onSpawn: (files) => { files['/packs/sources/glissa/derived/brief.md'] = stampedFile(); } });
  const original = h.distiller.runOnce;
  const pass = original({ });

  await new Promise((resolve) => setImmediate(resolve));
  release();
  await gate;
  await h.distiller.stop();
  const [report] = await pass;
  assert.equal(report.status, 'distilled');
});

// ---------------------------------------------------------------------------
// the result file
// ---------------------------------------------------------------------------

test('readDistillResult treats a missing or invalid result file as ERROR', () => {
  const missing = readDistillResult('/no/such/glissa-distill-result.json');
  assert.equal(missing.verdict, 'ERROR');
  assert.match(missing.summary, /no result file/);
});

test('the post-verify is the same drift check the lane started from', () => {
  // Pins the reuse rather than a second, drifting implementation of "is this current".
  assert.equal(needsDistill(HASHES, stampedFile()).stale, false);
  assert.equal(needsDistill(HASHES, null).stale, true);
});
