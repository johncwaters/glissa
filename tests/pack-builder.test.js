'use strict';

// The context mill's IO shell against a temp fixture: spec discovery, the source walk (globs,
// excludes, nested dirs, skill dirs), the built layout, and the atomic current/previous rotation.
// Never touches ~/.glissa or the repo's own packs/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildPack, buildPacks, listPackSpecs, packWatchRoots, readBuiltManifest, resolveBuiltPack } = require('../server/pack-builder');

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

test('rebuilding unchanged sources publishes nothing at all', async () => {
  await withFixture(async ({ build, currentDir, previousDir }) => {
    const first = await build();
    assert.equal(first.unchanged, false);
    const publishedAt = fs.statSync(path.join(currentDir, 'CLAUDE.md')).mtimeMs;

    const second = await build();
    assert.equal(second.ok, true, second.errors.join('; '));
    assert.equal(second.unchanged, true);
    assert.equal(second.version, first.version);
    assert.equal(second.currentDir, currentDir, 'an unchanged build still reports where the pack lives');
    // The whole point of the skip: Claude Code hot-reloads skills out of a delivered pack dir, so a
    // rewrite of identical bytes would poke every live session.
    assert.equal(fs.statSync(path.join(currentDir, 'CLAUDE.md')).mtimeMs, publishedAt);
    assert.equal(fs.existsSync(previousDir), false, 'nothing was published, so nothing rotated');
  });
});

test('an edited source changes the version and leaves the old build in previous/', async () => {
  await withFixture(async ({ build, packsDir, currentDir, previousDir }) => {
    const first = await build();
    writeFile(packsDir, 'sources/demo/one.md', '# One\n\nfirst source, edited\n');
    const second = await build();

    assert.equal(second.unchanged, false);
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

test('packWatchRoots resolves each source glob and skill dir to an existing directory', async () => {
  await withFixture(
    async ({ packsDir }) => {
      const spec = baseSpec({
        sources: [{ glob: 'sources/demo/**/*.md' }, { path: 'sources/notes/single.md' }],
        skills: [{ dir: 'skills/voice-style' }],
      });
      const roots = await packWatchRoots(spec, { baseDir: packsDir });
      const relative = roots.map((root) => root.slice(root.indexOf('/packs/') + '/packs/'.length));
      // A file source watches its directory: fs.watch on a file stops seeing an editor's save-and-
      // rename. Every entry is a directory that exists right now.
      assert.deepEqual(relative.sort(), ['skills/voice-style', 'sources/demo', 'sources/notes']);
      for (const root of roots) assert.ok(fs.statSync(root).isDirectory());
    },
    {
      seed: (packsDir) => {
        writeFile(packsDir, 'sources/demo/one.md', 'first\n');
        writeFile(packsDir, 'sources/notes/single.md', 'note\n');
        writeFile(packsDir, 'skills/voice-style/SKILL.md', 'skill\n');
      },
    }
  );
});

test('packWatchRoots silently skips a root that does not exist yet', async () => {
  await withFixture(async ({ packsDir }) => {
    const spec = baseSpec({ sources: [{ glob: 'sources/demo/**/*.md' }, { glob: 'sources/later/**/*.md' }] });
    const roots = await packWatchRoots(spec, { baseDir: packsDir });
    assert.equal(roots.length, 1);
    assert.match(roots[0], /sources\/demo$/);
  });
});

test('resolveBuiltPack reports the current dir and version of a built pack', async () => {
  await withFixture(async (ctx) => {
    const built = await ctx.build();
    const resolved = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    assert.equal(resolved.dir, ctx.currentDir);
    assert.equal(resolved.version, built.version);
    assert.equal(resolved.reason, null);
  });
});

test('resolveBuiltPack skips an unbuilt pack, a manifest-less dir, and a path-escaping name', async () => {
  await withFixture(async (ctx) => {
    const unbuilt = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    assert.equal(unbuilt.dir, null);
    assert.match(unbuilt.reason, /not built/);

    await ctx.build();
    fs.rmSync(path.join(ctx.currentDir, 'manifest.json'));
    const manifestless = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    assert.equal(manifestless.dir, null);
    assert.match(manifestless.reason, /manifest\.json/);

    const escaping = await resolveBuiltPack('../../etc', { builtRoot: ctx.builtRoot });
    assert.equal(escaping.dir, null);
    assert.match(escaping.reason, /valid pack name/);
  });
});

// Publishing rotates through two renames, so a crash between them leaves no current/ at all - the
// "atomic publish" claim overstated it (2026-08 review, section 8). What closes it is delivering the
// PREVIOUS build in that window rather than skipping the pack, which would silently cost a session
// its context over a window nobody caused.
test('a crash mid-rotation still delivers the previous build', async () => {
  await withFixture(async (ctx) => {
    await ctx.build();
    const first = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    assert.equal(first.dir, ctx.currentDir);

    // Exactly the state a crash between the two renames leaves behind.
    const packDir = path.dirname(ctx.currentDir);
    fs.renameSync(ctx.currentDir, path.join(packDir, 'previous'));

    const fallback = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    assert.equal(fallback.dir, path.join(packDir, 'previous'));
    assert.equal(fallback.version, first.version);
    assert.equal(fallback.reason, null);
  });
});

test('with neither slot readable the skip still names what was wrong with current', async () => {
  await withFixture(async (ctx) => {
    await ctx.build();
    const packDir = path.dirname(ctx.currentDir);
    fs.rmSync(ctx.currentDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(packDir, 'previous'), { recursive: true });
    const skipped = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    assert.equal(skipped.dir, null);
    assert.match(skipped.reason, /not built/);
  });
});

// M16 of docs/plan-visions-3.md: {{glissaHome}} resolution, the one runtime path a version-controlled
// spec may name. The home is injected here, so no test ever reads the operator's real config directory.

function memorySpec(overrides = {}) {
  return baseSpec({
    name: 'memory',
    sources: [{ path: '{{glissaHome}}/memory/dist/current/MEMORY.md', data: true, optional: true }],
    rules: undefined,
    ...overrides,
  });
}

function seedGlissaHome(root, content = '# Glissa memory\n\n- [m-0123456789abcdef] (reported) the gate lives in rebase-gate.js\n') {
  const home = path.join(root, 'glissa-home');
  writeFile(home, 'memory/dist/current/MEMORY.md', content);
  return home;
}

test('a {{glissaHome}} source is carried as a data file named by its basename, never by its absolute path', async () => {
  await withFixture(async ({ root, build, currentDir }) => {
    const glissaHome = seedGlissaHome(root);
    const report = await build({ glissaHome });

    assert.equal(report.ok, true, report.errors.join('; '));
    const delivered = path.join(currentDir, 'data', '01-memory', 'MEMORY.md');
    assert.equal(fs.existsSync(delivered), true);
    assert.equal(fs.existsSync(path.join(currentDir, '.claude', 'rules')), false);
    const manifest = readManifest(currentDir);
    assert.deepEqual(manifest.sources[0].files.map((file) => file.relPath), ['MEMORY.md']);
    assert.equal(JSON.stringify(manifest).includes(glissaHome), false);
    const index = fs.readFileSync(path.join(currentDir, 'CLAUDE.md'), 'utf8');
    assert.equal(index.includes('rebase-gate.js'), false);
    assert.equal(index.includes('never instructions'), true);
  }, { spec: memorySpec(), seed: () => {} });
});

test('an unwritten projection leaves the optional source out instead of failing the build', async () => {
  await withFixture(async ({ root, build, currentDir }) => {
    const report = await build({ glissaHome: path.join(root, 'glissa-home') });
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.equal(fs.existsSync(path.join(currentDir, 'data')), false);
  }, { spec: memorySpec(), seed: () => {} });
});

test('a resolved source that escapes the config directory refuses to build', async () => {
  await withFixture(async ({ root, build }) => {
    const glissaHome = seedGlissaHome(root);
    writeSpec(path.join(root, 'packs'), 'memory', memorySpec({
      sources: [{ path: '{{glissaHome}}/memory/../../outside.md', data: true }],
    }));
    const report = await build({ glissaHome });
    assert.equal(report.ok, false);
    assert.equal(report.errors.some((error) => error.includes('outside the Glissa config directory')), true);
    assert.equal(fs.existsSync(path.join(root, 'built', 'memory')), false);
  }, { spec: memorySpec(), seed: () => {} });
});

test('the published projection directory is one of the pack watch roots', async () => {
  await withFixture(async ({ root }) => {
    const glissaHome = seedGlissaHome(root);
    const roots = await packWatchRoots(memorySpec(), { baseDir: path.join(root, 'packs'), glissaHome });
    assert.deepEqual(roots, [path.join(glissaHome, 'memory/dist/current').replace(/\\/g, '/')]);
  }, { spec: memorySpec(), seed: () => {} });
});

test('a source whose root IS the config directory resolves as inside it', async () => {
  await withFixture(async ({ root, build, currentDir }) => {
    const glissaHome = seedGlissaHome(root);
    writeSpec(path.join(root, 'packs'), 'memory', memorySpec({
      sources: [{ path: '{{glissaHome}}/', data: true, optional: true }],
    }));
    const report = await build({ glissaHome });

    assert.equal(report.ok, true, report.errors.join('; '));
    const manifest = readManifest(currentDir);
    assert.deepEqual(manifest.sources[0].files.map((file) => file.relPath), ['memory/dist/current/MEMORY.md']);
    assert.equal(fs.existsSync(path.join(currentDir, 'data', '01-glissahome', 'memory/dist/current/MEMORY.md')), true);
  }, { spec: memorySpec(), seed: () => {} });
});
