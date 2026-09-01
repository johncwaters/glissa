'use strict';

// The distiller lane with every side effect faked: which entry drifts, what the spawned session is
// told, how a verdict is re-checked against the file actually written, that distills are serialized,
// that stop() drains one in flight, and that the whole lane is inert while disabled. No fs, no timers,
// no real session.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PACK_DISTILL_BOOTSTRAP_PROMPT,
  PACK_DISTILL_DENY_TOOLS,
  PACK_DISTILL_PROMPT_FILE,
  createDistillSpawn,
  createPackDistiller,
  packDistillerPermissions,
  readDistillResult,
  writeOutputNoFollow,
} = require('../server/pack-distiller');
const { distillOutputPath } = require('../server/pack-builder');
const { buildStampLine, needsDistill } = require('../server/core/distill-core.ts');
const { LANE_ENVIRONMENT_ARGS, buildLanePermissions } = require('../server/core/lane-permissions-core.ts');
const {
  MAX_DISTILL_PROMPT_BYTES,
  MAX_DISTILL_RESULT_BYTES,
  MAX_DISTILLED_CONTENT_CHARS,
  buildPackDistillPrompt,
  decidePackDistillPromptSize,
  renderDistilledOutput,
  validateDistillResult,
} = require('../server/core/pack-distiller-core.ts');
const { recordingSessionFactory } = require('./helpers/fake-session');

const HASHES = [
  { path: 'AGENTS.md', fullPath: 'C:/repo/AGENTS.md', sha256: 'a'.repeat(64) },
  { path: 'docs/plan.md', fullPath: 'C:/repo/docs/plan.md', sha256: 'b'.repeat(64) },
];

function stampedFile(sources = HASHES) {
  return `${buildStampLine(sources)}\n\nthe brief\n`;
}

function specWithDistill(overrides = {}) {
  return {
    name: 'house-rules',
    description: 'demo',
    sources: [{ glob: 'sources/house-rules/*.md' }],
    budgetTokens: 4000,
    distill: [{
      output: 'sources/house-rules/derived/brief.md',
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
  specs = [{ name: 'house-rules', specPath: '/specs/house-rules.pack.json' }],
  specByPath = { '/specs/house-rules.pack.json': specWithDistill() },
  hashes = HASHES,
  files = {},
  verdicts = ['DISTILLED'],
  readResultOverride = null,
  createResultFileOverride = null,
  onSpawn = null,
  onWrite = null,
  writePromptOverride = null,
  resolveOutputOverride = null,
  hangForever = false,
  hangUntilRelease = false,
  enabled = false,
  intervalHours = 24,
} = {}) {
  const spawns = [];
  const releases = [];
  const warnings = [];
  const intervals = [];
  const timeouts = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const removed = [];
  const writes = [];
  const promptWrites = [];

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
    resolveOutput: (output) => {
      if (resolveOutputOverride) return resolveOutputOverride(output);
      return output.includes('..') ? null : `/packs/${output}`;
    },
    readOutput: async (fullPath) => (fullPath in files ? files[fullPath] : null),
    writeOutput: async (fullPath, content) => {
      writes.push({ fullPath, content });
      if (onWrite) return onWrite(files, fullPath, content);
      files[fullPath] = content;
    },
    writePrompt: async (promptPath, content) => {
      promptWrites.push({ promptPath, content });
      if (writePromptOverride) await writePromptOverride(promptPath, content);
    },
    spawnDistill: async (args) => {
      spawns.push(args);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        // The real spawn resolves only once the destroyed PTY tree is reaped, so an aborted fake must
        // settle too rather than hanging: that is what the caller's drain waits for.
        if (hangForever) await new Promise((resolve) => { args.signal.addEventListener('abort', resolve, { once: true }); });
        if (hangUntilRelease && spawns.length === 1) await new Promise((resolve) => { releases.push(resolve); });
        await new Promise((resolve) => setImmediate(resolve));
        if (onSpawn) onSpawn(files, args);
      } finally {
        concurrent -= 1;
      }
    },
    // One dep carrying its own cleanup: the closure owns the directory, so nothing has to infer
    // ownership from the path (see createJobResultFile in server/ephemeral-session.js).
    createResultFile: (packName, index) => {
      if (createResultFileOverride) return createResultFileOverride(packName, index);
      const resultPath = `/tmp/${packName}-${index}.json`;
      return { path: resultPath, cleanup: () => removed.push(resultPath) };
    },
    readResult: async () => {
      if (readResultOverride) return readResultOverride();
      const verdict = verdicts.shift() || 'ERROR';
      if (typeof verdict === 'object') return verdict;
      return {
        ok: true,
        verdict,
        summary: `summary for ${verdict}`,
        content: verdict === 'ERROR' ? null : '# Brief\n\nDistilled body.',
      };
    },
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return { unref() { this.unrefed = true; } }; },
    clearIntervalFn: (handle) => { handle.cleared = true; },
    setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return { unref() {} }; },
    clearTimeoutFn: () => {},
    log: { log() {}, warn: (msg) => warnings.push(msg) },
  });

  return {
    distiller,
    spawns,
    warnings,
    intervals,
    timeouts,
    files,
    writes,
    promptWrites,
    removed,
    maxConcurrent: () => maxConcurrent,
    releaseHungSpawn: () => { for (const release of releases) release(); },
  };
}

// ---------------------------------------------------------------------------
// drift detection
// ---------------------------------------------------------------------------

test('an output whose stamp matches its sources is current, and nothing is spawned', async () => {
  const h = harness({ files: { '/packs/sources/house-rules/derived/brief.md': stampedFile() } });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'current');
  assert.equal(report.pack, 'house-rules');
  assert.equal(h.spawns.length, 0);
});

test('a missing output spawns one distill session and reports the written file', async () => {
  const h = harness();
  const [report] = await h.distiller.runOnce();

  assert.equal(h.spawns.length, 1);
  assert.equal(report.status, 'distilled');
  assert.equal(report.verdict, 'DISTILLED');
  assert.equal(report.output, 'sources/house-rules/derived/brief.md');
});

// The result directory is a real mkdtemp in production, so a distill that skips its cleanup leaks one
// per entry per pass. It is minted INSIDE the guarded region and released in a finally, so the verdict
// cannot decide whether it happens.
test('every distill releases its result file, on a clean verdict and on ERROR alike', async () => {
  const distilled = harness();
  await distilled.distiller.runOnce();
  assert.deepEqual(distilled.removed, ['/tmp/house-rules-0.json'], 'released after a DISTILLED verdict');

  const failed = harness({ verdicts: ['ERROR'] });
  const [report] = await failed.distiller.runOnce();
  assert.equal(report.verdict, 'ERROR');
  assert.deepEqual(failed.removed, ['/tmp/house-rules-0.json'], 'and after an ERROR one');
});

test('an edited source spawns a distill even though the output exists', async () => {
  const h = harness({
    files: { '/packs/sources/house-rules/derived/brief.md': stampedFile([{ path: 'AGENTS.md', sha256: 'f'.repeat(64) }]) },
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

test('the prompt file names the target as read-only context and the spawn runs from its directory', async () => {
  const h = harness();
  await h.distiller.runOnce();

  const [spawn] = h.spawns;
  const [promptWrite] = h.promptWrites;
  assert.equal(promptWrite.promptPath, `/tmp/${PACK_DISTILL_PROMPT_FILE}`);
  assert.match(promptWrite.content, /\/packs\/sources\/house-rules\/derived\/brief\.md/);
  assert.match(promptWrite.content, /C:\/repo\/AGENTS\.md/);
  assert.ok(promptWrite.content.includes('Write a one page architecture brief.'));
  assert.equal(promptWrite.content.includes(buildStampLine(HASHES)), false);
  assert.match(promptWrite.content, /Glissa alone writes that output file/);
  assert.match(promptWrite.content, /\/tmp\/house-rules-0\.json/);
  assert.equal(spawn.cwd, '/tmp');
  assert.equal(spawn.id, 'pack-distill:house-rules#0');
  assert.ok(spawn.signal, 'a timeout signal is always passed');
});

test('hostile instructions stay byte-identical in the prompt file and never reach spawn arguments', async () => {
  const hostileInstructions = 'Quote "this" and preserve %PATH% ^ & | < > plus \'single quotes\'.';
  const spec = specWithDistill();
  spec.distill[0].instructions = hostileInstructions;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-distiller-hostile-'));
  const resultPath = path.join(workDir, 'result.json');
  try {
    const h = harness({
      specByPath: { '/specs/house-rules.pack.json': spec },
      createResultFileOverride: () => ({ path: resultPath, cleanup: async () => {} }),
      writePromptOverride: (promptPath, content) => fs.promises.writeFile(promptPath, content, 'utf8'),
    });
    await h.distiller.runOnce();

    const expectedPrompt = buildPackDistillPrompt({
      outputPath: '/packs/sources/house-rules/derived/brief.md',
      sources: HASHES,
      instructions: hostileInstructions,
      resultPath,
    });
    assert.equal(fs.readFileSync(path.join(workDir, PACK_DISTILL_PROMPT_FILE), 'utf8'), expectedPrompt);
    assert.equal(JSON.stringify(h.spawns).includes(hostileInstructions), false);
    assert.doesNotMatch(PACK_DISTILL_BOOTSTRAP_PROMPT, /["'%^&|<>\r\n]/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('an oversized prompt fails before the prompt write and spawn boundaries', async () => {
  const spec = specWithDistill();
  spec.distill[0].instructions = 'x'.repeat(MAX_DISTILL_PROMPT_BYTES);
  const h = harness({ specByPath: { '/specs/house-rules.pack.json': spec } });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.equal(report.reason, 'prompt-too-large');
  assert.deepEqual(h.promptWrites, []);
  assert.deepEqual(h.spawns, []);
  assert.deepEqual(h.writes, []);
});

test('the distiller posture is the shared acceptEdits posture with no write-shaped rule', () => {
  const posture = packDistillerPermissions();
  assert.deepEqual(posture, buildLanePermissions({ denyTools: PACK_DISTILL_DENY_TOOLS }));
  assert.deepEqual(posture.permissions, {
    deny: ['Bash', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
    defaultMode: 'acceptEdits',
  });
  assert.equal(Object.hasOwn(posture.permissions, 'allow'), false);
  for (const tool of ['Read', 'Write', 'Glob', 'Grep']) {
    assert.equal(posture.permissions.deny.includes(tool), false);
  }
});

test('the spawned Session receives the shared posture and never skips permissions', async () => {
  const { makeSession, constructed } = recordingSessionFactory();
  const controller = new AbortController();
  controller.abort();
  const spawn = createDistillSpawn({ hookRouter: {}, makeSession });
  await spawn({ id: 'distill:1', name: 'distill one', cwd: '/tmp/job', signal: controller.signal });

  assert.equal(constructed.length, 1);
  assert.equal(constructed[0].path, '/tmp/job');
  assert.equal(constructed[0].dangerouslySkipPermissions, false);
  assert.equal(constructed[0].initialPrompt, PACK_DISTILL_BOOTSTRAP_PROMPT);
  assert.deepEqual(constructed[0].settingsPermissions, packDistillerPermissions().permissions);
  assert.deepEqual(constructed[0].extraClaudeArgs, ['-p', ...LANE_ENVIRONMENT_ARGS]);
});

// ---------------------------------------------------------------------------
// verdicts are re-checked against the file on disk
// ---------------------------------------------------------------------------

test('a successful result that cannot be written is an ERROR, not a success', async () => {
  const h = harness({ onWrite: () => {} });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /output file is missing/);
  assert.equal(h.warnings.length, 1);
});

test('a throwing writer reports ERROR and leaves the output unwritten', async () => {
  const h = harness({ onWrite: () => { throw new Error('disk full'); } });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.equal(report.verdict, 'ERROR');
  assert.match(report.reason, /could not write output: disk full/);
  assert.deepEqual(h.files, {});
});

test('an ELOOP writer refusal is reported as an unsafe output path', async () => {
  const error = new Error('too many symbolic links');
  error.code = 'ELOOP';
  const h = harness({ onWrite: () => { throw error; } });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.equal(report.verdict, 'ERROR');
  assert.equal(report.reason, 'output path became a symbolic link');
});

test('a final symlink planted after output resolution is refused without changing its target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-distiller-symlink-'));
  const packsDirectory = path.join(root, 'packs');
  const outputDirectory = path.join(packsDirectory, 'sources', 'demo');
  const externalTarget = path.join(root, 'external.md');
  const relativeOutput = path.join('sources', 'demo', 'brief.md');
  try {
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(externalTarget, 'outside\n', 'utf8');
    const outputPath = await distillOutputPath(relativeOutput, { baseDir: packsDirectory });
    fs.symlinkSync(externalTarget, outputPath, 'file');

    await assert.rejects(
      writeOutputNoFollow(outputPath, 'replacement\n'),
      (error) => error.code === 'ELOOP',
    );
    assert.equal(fs.readFileSync(externalTarget, 'utf8'), 'outside\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the output writer creates missing parent directories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-distiller-parent-'));
  const outputPath = path.join(root, 'new', 'nested', 'brief.md');
  try {
    await writeOutputNoFollow(outputPath, 'derived\n');
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'derived\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed output rename leaves the old derived source byte-identical', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-distiller-rename-'));
  const outputPath = path.join(root, 'brief.md');
  fs.writeFileSync(outputPath, 'old bytes\n', 'utf8');
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (source, destination) => {
    if (destination === outputPath) throw new Error('simulated crash before replace');
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(writeOutputNoFollow(outputPath, 'new bytes\n'), /simulated crash/);
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'old bytes\n');
    assert.deepEqual(fs.readdirSync(root), ['brief.md']);
  } finally {
    fs.promises.rename = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the post-write check rejects storage that changes Glissa rendered bytes', async () => {
  const h = harness({
    onWrite: (files, fullPath) => {
      files[fullPath] = stampedFile([{ path: 'AGENTS.md', sha256: 'c'.repeat(64) }]);
    },
  });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /sources changed/);
});

test('the post-write check rejects storage that drops Glissa stamp', async () => {
  const h = harness({
    onWrite: (files, fullPath) => { files[fullPath] = '# Brief\n\nno stamp\n'; },
  });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /no distill stamp/);
});

test('a NO_CHANGE verdict is accepted once the stamp on disk is current', async () => {
  const h = harness({ verdicts: ['NO_CHANGE'] });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'distilled');
  assert.equal(report.verdict, 'NO_CHANGE');
});

test('Glissa renders the sole output from validated structured content', async () => {
  const content = '# Agent body\r\n\r\nGenerated text.\r\n';
  const h = harness({
    verdicts: [{ ok: true, verdict: 'DISTILLED', summary: 'rendered', content }],
  });
  const [report] = await h.distiller.runOnce();
  const expected = renderDistilledOutput({ sources: HASHES, content });

  assert.equal(report.status, 'distilled');
  assert.deepEqual(h.writes, [{
    fullPath: '/packs/sources/house-rules/derived/brief.md',
    content: expected,
  }]);
  assert.equal(h.files['/packs/sources/house-rules/derived/brief.md'], expected);
});

test('a malformed structured result fails the distill and writes nothing', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-distiller-malformed-'));
  const resultPath = path.join(workDir, 'result.json');
  try {
    fs.writeFileSync(resultPath, JSON.stringify({ verdict: 'DISTILLED', content: 42 }), 'utf8');
    const h = harness({ readResultOverride: () => readDistillResult(resultPath) });
    const [report] = await h.distiller.runOnce();

    assert.equal(report.status, 'error');
    assert.match(report.reason, /no distilled content/);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.files, {});
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
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

// The serialization promise: the result dir is released and the next entry started only after the aborted spawn settles (drainPending).
test('a timed-out distill waits for the killed session before releasing its result file or starting the next entry', async () => {
  const h = harness({
    specByPath: {
      '/specs/house-rules.pack.json': specWithDistill({
        distill: [
          { output: 'sources/house-rules/derived/one.md', sources: [{ path: '../AGENTS.md' }], instructions: 'one' },
          { output: 'sources/house-rules/derived/two.md', sources: [{ path: '../AGENTS.md' }], instructions: 'two' },
        ],
      }),
    },
    verdicts: ['DISTILLED', 'DISTILLED'],
    hangUntilRelease: true,
  });

  const pass = h.distiller.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  h.timeouts[0].fn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.spawns[0].signal.aborted, true, 'the hung session was told to stop');
  assert.deepEqual(h.removed, [], 'the result directory outlives the verdict, not the process');
  assert.equal(h.spawns.length, 1, 'the next entry has not started under the dying one');

  h.releaseHungSpawn();
  const reports = await pass;

  assert.equal(h.spawns.length, 2);
  assert.equal(h.maxConcurrent(), 1);
  assert.deepEqual(h.removed, ['/tmp/house-rules-0.json', '/tmp/house-rules-1.json']);
  assert.match(reports[0].reason, /timed out/);
  assert.equal(reports[1].status, 'distilled');
});

// ---------------------------------------------------------------------------
// entries that never reach a session
// ---------------------------------------------------------------------------

test('an output path that escapes the packs directory errors before any spawn', async () => {
  const h = harness({
    specByPath: {
      '/specs/house-rules.pack.json': specWithDistill({
        distill: [{ output: '../outside.md', sources: [{ path: '../AGENTS.md' }], instructions: 'x' }],
      }),
    },
  });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /escapes the packs directory/);
  assert.equal(h.spawns.length, 0);
});

test('an output resolver error refuses the entry during either safety check', async () => {
  const failure = new Error('permission denied');
  failure.code = 'EACCES';
  const firstCheck = harness({ resolveOutputOverride: async () => { throw failure; } });
  const [firstReport] = await firstCheck.distiller.runOnce();
  assert.match(firstReport.reason, /escapes the packs directory/);
  assert.equal(firstCheck.spawns.length, 0);

  let calls = 0;
  const entryCheck = harness({
    resolveOutputOverride: async (output) => {
      calls += 1;
      if (calls > 1) throw failure;
      return `/packs/${output}`;
    },
  });
  const [entryReport] = await entryCheck.distiller.runOnce();
  assert.match(entryReport.reason, /escapes the packs directory/);
  assert.equal(entryCheck.spawns.length, 0);
});

test('distill sources that matched no file error instead of distilling from nothing', async () => {
  const h = harness({ hashes: [] });
  const [report] = await h.distiller.runOnce();

  assert.equal(report.status, 'error');
  assert.match(report.reason, /matched no files/);
  assert.equal(h.spawns.length, 0);
});

test('a spec with no distill entries is skipped silently', async () => {
  const h = harness({ specByPath: { '/specs/house-rules.pack.json': specWithDistill({ distill: undefined }) } });
  assert.deepEqual(await h.distiller.runOnce(), []);
  assert.equal(h.spawns.length, 0);
});

test('a spec that declares distill but fails validation errors instead of spawning', async () => {
  const h = harness({ specByPath: { '/specs/house-rules.pack.json': specWithDistill({ budgetTokens: 0 }) } });
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
    specs: [{ name: 'house-rules', specPath: '/specs/house-rules.pack.json' }, { name: 'other', specPath: '/specs/other.pack.json' }],
    specByPath: {
      '/specs/house-rules.pack.json': specWithDistill(),
      '/specs/other.pack.json': specWithDistill({ name: 'other' }),
    },
    verdicts: ['DISTILLED', 'DISTILLED'],
    onSpawn: (files) => { files['/packs/sources/house-rules/derived/brief.md'] = stampedFile(); },
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
      '/specs/house-rules.pack.json': specWithDistill({
        distill: [
          { output: 'sources/house-rules/derived/one.md', sources: [{ path: '../AGENTS.md' }], instructions: 'one' },
          { output: 'sources/house-rules/derived/two.md', sources: [{ path: '../AGENTS.md' }], instructions: 'two' },
        ],
      }),
    },
    verdicts: ['DISTILLED', 'DISTILLED'],
  });
  const reports = await h.distiller.runOnce();

  assert.equal(h.spawns.length, 2);
  assert.equal(h.maxConcurrent(), 1);
  assert.deepEqual(reports.map((r) => r.status), ['distilled', 'distilled']);
});

test('two overlapping passes queue behind each other rather than racing the same output', async () => {
  const h = harness({
    verdicts: ['DISTILLED', 'DISTILLED'],
    onSpawn: (files) => { files['/packs/sources/house-rules/derived/brief.md'] = stampedFile(); },
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
    onSpawn: (files) => { files['/packs/sources/house-rules/derived/brief.md'] = stampedFile(); },
  });
  await h.distiller.start();

  assert.equal(h.spawns.length, 1, 'a source edited while Glissa was down is caught at boot');
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].ms, 6 * 3600000);
  await h.distiller.stop();
});

test('the interval tick runs another pass, and is re-entrancy guarded', async () => {
  let hashVersion = 0;
  const h = harness({
    enabled: true,
    verdicts: ['DISTILLED', 'DISTILLED', 'DISTILLED'],
    hashes: () => [{
      ...HASHES[0],
      sha256: String(++hashVersion).padEnd(64, '0'),
    }],
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
  const h = harness({ onSpawn: (files) => { files['/packs/sources/house-rules/derived/brief.md'] = stampedFile(); } });
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

test('readDistillResult distinguishes unreadable files from invalid JSON', async () => {
  const missing = await readDistillResult('/no/such/glissa-distill-result.json');
  assert.equal(missing.verdict, 'ERROR');
  assert.match(missing.summary, /no readable result file/);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-distiller-test-'));
  const resultPath = path.join(workDir, 'result.json');
  try {
    fs.writeFileSync(resultPath, '{not json', 'utf8');
    const malformed = await readDistillResult(resultPath);
    assert.equal(malformed.verdict, 'ERROR');
    assert.match(malformed.summary, /invalid JSON/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('an oversized result file fails before parsing and writes no pack output', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-distiller-large-result-'));
  const resultPath = path.join(workDir, 'result.json');
  try {
    fs.writeFileSync(resultPath, 'x'.repeat(MAX_DISTILL_RESULT_BYTES + 1), 'utf8');
    const oversized = await readDistillResult(resultPath);
    const h = harness({ readResultOverride: () => oversized });
    const [report] = await h.distiller.runOnce();

    assert.equal(report.status, 'error');
    assert.equal(report.reason, 'result file is too large');
    assert.deepEqual(h.writes, []);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('oversized distilled content fails pure validation and writes no pack output', async () => {
  const oversized = validateDistillResult({
    verdict: 'DISTILLED',
    summary: 'done',
    content: 'x'.repeat(MAX_DISTILLED_CONTENT_CHARS + 1),
  });
  const h = harness({ readResultOverride: () => oversized });
  const [report] = await h.distiller.runOnce();

  assert.equal(oversized.summary, 'distilled content is too large');
  assert.equal(report.status, 'error');
  assert.equal(report.reason, 'distilled content is too large');
  assert.deepEqual(h.writes, []);
});

test('the pure result contract validates content before the renderer owns the stamp', () => {
  const checked = validateDistillResult({
    verdict: 'DISTILLED',
    summary: 'done\nignored',
    content: '# Brief\r\n\r\nBody',
  });
  assert.deepEqual(checked, {
    ok: true,
    verdict: 'DISTILLED',
    summary: 'done',
    content: '# Brief\r\n\r\nBody',
  });
  assert.equal(
    renderDistilledOutput({ sources: HASHES, content: checked.content }),
    `${buildStampLine(HASHES)}\n\n# Brief\n\nBody\n`
  );
});

test('the prompt permits one structured result file and reserves target rendering for Glissa', () => {
  const prompt = buildPackDistillPrompt({
    outputPath: '/packs/derived.md',
    sources: HASHES,
    instructions: 'Condense the architecture.',
    resultPath: '/tmp/job/result.json',
  });
  assert.match(prompt, /Write only \/tmp\/job\/result\.json/);
  assert.match(prompt, /Do not write \/packs\/derived\.md/);
  assert.match(prompt, /complete document body/);
  assert.equal(prompt.includes(buildStampLine(HASHES)), false);
  assert.deepEqual(decidePackDistillPromptSize(prompt), {
    dispatch: true,
    gate: null,
    promptBytes: Buffer.byteLength(prompt),
  });
});

test('the post-verify is the same drift check the lane started from', () => {
  // Pins the reuse rather than a second, drifting implementation of "is this current".
  assert.equal(needsDistill(HASHES, stampedFile()).stale, false);
  assert.equal(needsDistill(HASHES, null).stale, true);
});
