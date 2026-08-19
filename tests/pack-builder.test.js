'use strict';

// The context mill's IO shell against a temp fixture: spec discovery, the source walk (globs,
// excludes, nested dirs, skill dirs), the built layout, and the atomic current/previous rotation.
// Never touches ~/.glissa or the repo's own packs/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildPack, buildPacks, listPackSpecs, readBuiltManifest } = require('../server/pack-builder');

function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function writeSpec(packsDir, name, spec) {
  writeFile(packsDir, path.join('specs', `${name}.pack.json`), `${JSON.stringify(spec, null, 2)}\n`);
}

function baseSpec(overrides = {}) {
  return {
    name: 'demo',
    description: 'a demo pack',
    sources: [{ glob: 'sources/demo/**/*.md' }],
    rules: ['keep it short'],
    budgetTokens: 4000,
    ...overrides,
  };
}

async function withFixture(run, { spec = baseSpec(), seed = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-packs-'));
  const packsDir = path.join(root, 'packs');
  const builtRoot = path.join(root, 'built');
  try {
    writeSpec(packsDir, spec.name, spec);
    if (seed) {
      seed(packsDir);
    }
    if (!seed) {
      writeFile(packsDir, 'sources/demo/one.md', '# One\n\nfirst source\n');
      writeFile(packsDir, 'sources/demo/nested/two.md', '# Two\n\nsecond source\n');
    }
    const context = {
      root,
      packsDir,
      builtRoot,
      specsDir: path.join(packsDir, 'specs'),
      specPath: path.join(packsDir, 'specs', `${spec.name}.pack.json`),
      build: (options = {}) => buildPack({
        specPath: path.join(packsDir, 'specs', `${spec.name}.pack.json`),
        baseDir: packsDir,
        builtRoot,
        ...options,
      }),
      currentDir: path.join(builtRoot, spec.name, 'current'),
      previousDir: path.join(builtRoot, spec.name, 'previous'),
    };
    return await run(context);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

test('listPackSpecs finds every .pack.json and sorts it by name', async () => {
  await withFixture(async ({ packsDir, specsDir }) => {
    writeSpec(packsDir, 'alpha', baseSpec({ name: 'alpha' }));
    writeFile(packsDir, 'specs/notes.txt', 'not a spec');

    const specs = await listPackSpecs({ specsDir });
    assert.deepEqual(specs.map((spec) => spec.name), ['alpha', 'demo']);
  });
});

test('listPackSpecs returns nothing for a missing specs dir rather than throwing', async () => {
  const specs = await listPackSpecs({ specsDir: path.join(os.tmpdir(), 'glissa-packs-does-not-exist') });
  assert.deepEqual(specs, []);
});

test('a build writes the pack layout under current/', async () => {
  await withFixture(async ({ build, currentDir }) => {
    const report = await build();
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.equal(report.currentDir, currentDir);

    assert.ok(fs.existsSync(path.join(currentDir, 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(currentDir, '.claude', 'rules', '01-demo.md')));
    assert.ok(fs.existsSync(path.join(currentDir, 'manifest.json')));

    const rules = fs.readFileSync(path.join(currentDir, '.claude', 'rules', '01-demo.md'), 'utf8');
    assert.match(rules, /first source/);
    assert.match(rules, /second source/);
  });
});

test('the manifest records the sources that were walked, with hashes', async () => {
  await withFixture(async ({ build, currentDir }) => {
    const report = await build({ now: () => Date.parse('2026-08-19T00:00:00.000Z') });
    const manifest = readManifest(currentDir);

    assert.equal(manifest.name, 'demo');
    assert.equal(manifest.version, report.version);
    assert.equal(manifest.builtAt, '2026-08-19T00:00:00.000Z');
    assert.deepEqual(
      manifest.sources[0].files.map((file) => file.relPath),
      ['sources/demo/nested/two.md', 'sources/demo/one.md']
    );
    assert.equal(manifest.budgetOk, true);
  });
});

test('rebuilding unchanged sources yields the same version and rotates the old build to previous/', async () => {
  await withFixture(async ({ build, currentDir, previousDir }) => {
    const first = await build();
    assert.equal(fs.existsSync(previousDir), false);

    const second = await build();
    assert.equal(second.version, first.version);
    assert.ok(fs.existsSync(previousDir));
    assert.equal(readManifest(previousDir).version, first.version);
    assert.equal(readManifest(currentDir).version, second.version);
  });
});

test('an edited source changes the version and leaves the old build in previous/', async () => {
  await withFixture(async ({ build, packsDir, currentDir, previousDir }) => {
    const first = await build();
    writeFile(packsDir, 'sources/demo/one.md', '# One\n\nfirst source, edited\n');
    const second = await build();

    assert.notEqual(second.version, first.version);
    assert.equal(readManifest(previousDir).version, first.version);
    assert.equal(readManifest(currentDir).version, second.version);
    assert.match(fs.readFileSync(path.join(currentDir, '.claude', 'rules', '01-demo.md'), 'utf8'), /edited/);
  });
});

test('exclude patterns drop matched files from the walk', async () => {
  await withFixture(
    async ({ build, currentDir }) => {
      const report = await build();
      assert.equal(report.ok, true, report.errors.join('; '));

      const manifest = readManifest(currentDir);
      const paths = manifest.sources[0].files.map((file) => file.relPath);
      assert.deepEqual(paths, ['sources/demo/keep.md']);
      assert.doesNotMatch(fs.readFileSync(path.join(currentDir, '.claude', 'rules', '01-demo.md'), 'utf8'), /archived/);
    },
    {
      spec: baseSpec({ sources: [{ glob: 'sources/demo/**/*.md', exclude: ['**/archive/**'] }] }),
      seed: (packsDir) => {
        writeFile(packsDir, 'sources/demo/keep.md', 'keep me\n');
        writeFile(packsDir, 'sources/demo/archive/old.md', 'archived\n');
      },
    }
  );
});

test('a literal directory source takes every file under it', async () => {
  await withFixture(
    async ({ build, currentDir }) => {
      const report = await build();
      assert.equal(report.ok, true, report.errors.join('; '));
      assert.deepEqual(
        readManifest(currentDir).sources[0].files.map((file) => file.relPath),
        ['sources/notes/a.md', 'sources/notes/deep/b.md']
      );
    },
    {
      spec: baseSpec({ sources: [{ path: 'sources/notes' }] }),
      seed: (packsDir) => {
        writeFile(packsDir, 'sources/notes/a.md', 'alpha\n');
        writeFile(packsDir, 'sources/notes/deep/b.md', 'beta\n');
      },
    }
  );
});

test('a skill dir is copied into .claude/skills, keeping its tree', async () => {
  await withFixture(
    async ({ build, currentDir }) => {
      const report = await build();
      assert.equal(report.ok, true, report.errors.join('; '));
      assert.equal(fs.readFileSync(path.join(currentDir, '.claude', 'skills', 'voice-style', 'SKILL.md'), 'utf8'), 'skill body\n');
      assert.ok(fs.existsSync(path.join(currentDir, '.claude', 'skills', 'voice-style', 'references', 'tone.md')));
    },
    {
      spec: baseSpec({ skills: [{ dir: 'skills/voice-style' }] }),
      seed: (packsDir) => {
        writeFile(packsDir, 'sources/demo/one.md', 'first source\n');
        writeFile(packsDir, 'skills/voice-style/SKILL.md', 'skill body\n');
        writeFile(packsDir, 'skills/voice-style/references/tone.md', 'tone body\n');
      },
    }
  );
});

test('an over-budget pack fails and writes nothing at all', async () => {
  await withFixture(
    async ({ build, builtRoot }) => {
      const report = await build();
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((error) => error.includes('token budget')));
      assert.equal(fs.existsSync(path.join(builtRoot, 'demo')), false);
    },
    {
      spec: baseSpec({ budgetTokens: 10 }),
      seed: (packsDir) => writeFile(packsDir, 'sources/demo/one.md', 'x'.repeat(8000)),
    }
  );
});

test('a failed rebuild leaves the last good build in place', async () => {
  await withFixture(async ({ build, packsDir, currentDir, specPath }) => {
    const good = await build();
    fs.writeFileSync(specPath, JSON.stringify({ ...baseSpec(), budgetTokens: 5 }, null, 2), 'utf8');
    const bad = await build();

    assert.equal(bad.ok, false);
    assert.equal(readManifest(currentDir).version, good.version);
    assert.ok(fs.existsSync(path.join(packsDir, 'specs', 'demo.pack.json')));
  });
});

test('a source that matches nothing fails the build with the offending pattern', async () => {
  await withFixture(
    async ({ build }) => {
      const report = await build();
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((error) => error.includes('sources/missing')));
    },
    {
      spec: baseSpec({ sources: [{ glob: 'sources/missing/*.md' }] }),
      seed: (packsDir) => writeFile(packsDir, 'sources/demo/one.md', 'first source\n'),
    }
  );
});

test('a spec whose name disagrees with its filename is refused', async () => {
  await withFixture(async ({ build, specPath }) => {
    fs.writeFileSync(specPath, JSON.stringify({ ...baseSpec(), name: 'other' }, null, 2), 'utf8');
    const report = await build();
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => error.includes('does not match its filename')));
  });
});

test('unreadable JSON is reported as a spec error, not an exception', async () => {
  await withFixture(async ({ build, specPath }) => {
    fs.writeFileSync(specPath, '{ not json', 'utf8');
    const report = await build();
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => error.includes('could not read spec')));
  });
});

test('a stale tmp dir from a crashed build is swept before the next one', async () => {
  await withFixture(async ({ build, builtRoot }) => {
    const stale = path.join(builtRoot, 'demo', 'tmp-deadbeef');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'junk.md'), 'junk', 'utf8');

    const report = await build();
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.equal(fs.existsSync(stale), false);
    assert.deepEqual(fs.readdirSync(path.join(builtRoot, 'demo')).sort(), ['current']);
  });
});

test('buildPacks builds every spec, and one named spec on request', async () => {
  await withFixture(async ({ packsDir, specsDir, builtRoot }) => {
    writeSpec(packsDir, 'alpha', baseSpec({ name: 'alpha' }));

    const all = await buildPacks({ specsDir, baseDir: packsDir, builtRoot });
    assert.deepEqual(all.map((report) => report.name), ['alpha', 'demo']);
    assert.ok(all.every((report) => report.ok), all.map((report) => report.errors.join('; ')).join(' | '));

    const one = await buildPacks({ name: 'demo', specsDir, baseDir: packsDir, builtRoot });
    assert.deepEqual(one.map((report) => report.name), ['demo']);
  });
});

test('buildPacks reports an unknown name instead of silently building nothing', async () => {
  await withFixture(async ({ packsDir, specsDir, builtRoot }) => {
    const reports = await buildPacks({ name: 'nope', specsDir, baseDir: packsDir, builtRoot });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].ok, false);
    assert.ok(reports[0].errors.some((error) => error.includes('no spec named')));
  });
});

test('readBuiltManifest reads a built pack and null for one never built', async () => {
  await withFixture(async ({ build, builtRoot }) => {
    assert.equal(await readBuiltManifest('demo', { builtRoot }), null);
    const report = await build();
    const manifest = await readBuiltManifest('demo', { builtRoot });
    assert.equal(manifest.version, report.version);
  });
});

test('the repo proof pack builds from its own spec', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-proof-pack-'));
  try {
    const report = await buildPack({
      specPath: path.join(__dirname, '..', 'packs', 'specs', 'company-context.pack.json'),
      builtRoot: root,
    });
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.ok(report.tokenEstimate <= report.budgetTokens);
    assert.ok(fs.existsSync(path.join(root, 'company-context', 'current', 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(root, 'company-context', 'current', '.claude', 'rules', '01-company-context.md')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
