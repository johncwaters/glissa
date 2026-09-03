import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildPack, buildPacks, distillOutputPath, listPackSpecs, packSourceRoots, packWatchRoots,
  publishBuild, readBuiltManifest, resolveBuiltPack,
} from '../server/pack-builder.ts';
import type { BuildReport } from '../server/pack-builder.ts';
import type { PackManifest } from '../server/core/pack-core.ts';
import { projectVariantSlug } from '../server/core/pack-core.ts';

interface SpecFixture {
  name: string;
  [field: string]: unknown;
}

type ProjectRecord = Record<string, unknown>;

interface BuildOverrides {
  glissaHome?: string | null;
  projects?: ProjectRecord[];
  now?: () => number;
  builtRoot?: string;
}

interface FixtureContext {
  root: string;
  packsDir: string;
  builtRoot: string;
  specsDir: string;
  specPath: string;
  build: (options?: BuildOverrides) => Promise<BuildReport>;
  currentDir: () => string;
}

interface FixtureOptions {
  spec?: SpecFixture;
  seed?: ((packsDir: string) => void) | null;
}

function writeFile(root: string, relPath: string, content: string): string {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function writeSpec(packsDir: string, name: string, spec: SpecFixture): void {
  writeFile(packsDir, path.join('specs', `${name}.pack.json`), `${JSON.stringify(spec, null, 2)}\n`);
}

function currentVersionDir(builtRoot: string, name: string): string {
  const packDir = path.join(builtRoot, name);
  const version = fs.readFileSync(path.join(packDir, 'current', 'version'), 'utf8').trim();
  return path.join(packDir, 'versions', version);
}

function baseSpec(overrides: Record<string, unknown> = {}): SpecFixture {
  return {
    description: 'a demo pack',
    sources: [{ glob: 'sources/demo/**/*.md' }],
    rules: ['keep it short'],
    budgetTokens: 4000,
    ...overrides,
    name: typeof overrides.name === 'string' ? overrides.name : 'demo',
  };
}

async function withFixture<T>(
  run: (context: FixtureContext) => Promise<T>,
  { spec = baseSpec(), seed = null }: FixtureOptions = {},
): Promise<T> {
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
    const context: FixtureContext = {
      root,
      packsDir,
      builtRoot,
      specsDir: path.join(packsDir, 'specs'),
      specPath: path.join(packsDir, 'specs', `${spec.name}.pack.json`),
      build: (options: BuildOverrides = {}) => buildPack({
        specPath: path.join(packsDir, 'specs', `${spec.name}.pack.json`),
        baseDir: packsDir,
        builtRoot,
        ...options,
      }),
      currentDir: () => currentVersionDir(builtRoot, spec.name),
    };
    return await run(context);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readManifest(dir: string): PackManifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('a manifest is a JSON object');
  return parsed as PackManifest;
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

test('distillOutputPath refuses symlinks at the target and in every existing parent segment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-distill-output-'));
  const packsDir = path.join(root, 'packs');
  const outsideDir = path.join(root, 'outside');
  try {
    fs.mkdirSync(path.join(packsDir, 'sources', 'demo'), { recursive: true });
    fs.mkdirSync(outsideDir);
    const relativeOutput = path.join('sources', 'demo', 'derived', 'brief.md');
    const expectedOutput = path.join(packsDir, relativeOutput);
    assert.equal(await distillOutputPath(relativeOutput, { baseDir: packsDir }), expectedOutput);

    fs.symlinkSync(outsideDir, path.join(packsDir, 'sources', 'demo', 'derived'), 'dir');
    assert.equal(await distillOutputPath(relativeOutput, { baseDir: packsDir }), null);
    fs.rmSync(path.join(packsDir, 'sources', 'demo', 'derived'));

    fs.mkdirSync(path.dirname(expectedOutput));
    const outsideFile = writeFile(outsideDir, 'brief.md', 'outside\n');
    fs.symlinkSync(outsideFile, expectedOutput, 'file');
    assert.equal(await distillOutputPath(relativeOutput, { baseDir: packsDir }), null);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('distillOutputPath refuses a non-ENOENT lstat error instead of aborting the pass', async (t) => {
  const refusal: NodeJS.ErrnoException = new Error('permission denied');
  refusal.code = 'EACCES';
  t.mock.method(fsp, 'lstat', async () => { throw refusal; });
  assert.equal(await distillOutputPath('sources/demo/brief.md', { baseDir: '/packs' }), null);
});

test('a build writes the pack layout under its pointed version directory', async () => {
  await withFixture(async ({ build, currentDir }) => {
    const report = await build();
    const versionDir = currentDir();
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.equal(report.currentDir, versionDir);

    assert.ok(fs.existsSync(path.join(versionDir, 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(versionDir, '.claude', 'rules', '01-demo.md')));
    assert.ok(fs.existsSync(path.join(versionDir, 'manifest.json')));

    const rules = fs.readFileSync(path.join(versionDir, '.claude', 'rules', '01-demo.md'), 'utf8');
    assert.match(rules, /first source/);
    assert.match(rules, /second source/);
  });
});

test('the manifest records the sources that were walked, with hashes', async () => {
  await withFixture(async ({ build, currentDir }) => {
    const report = await build({ now: () => Date.parse('2026-08-19T00:00:00.000Z') });
    const manifest = readManifest(currentDir());

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
  await withFixture(async ({ build, currentDir }) => {
    const first = await build();
    const firstDir = currentDir();
    assert.equal(first.unchanged, false);
    const publishedAt = fs.statSync(path.join(firstDir, 'CLAUDE.md')).mtimeMs;

    const second = await build();
    assert.equal(second.ok, true, second.errors.join('; '));
    assert.equal(second.unchanged, true);
    assert.equal(second.version, first.version);
    assert.equal(second.currentDir, firstDir, 'an unchanged build still reports where the pack lives');

    assert.equal(fs.statSync(path.join(firstDir, 'CLAUDE.md')).mtimeMs, publishedAt);
  });
});

test('an edited source changes the pointer and retains the old immutable version', async () => {
  await withFixture(async ({ build, packsDir, currentDir }) => {
    const first = await build();
    const firstDir = currentDir();
    writeFile(packsDir, 'sources/demo/one.md', '# One\n\nfirst source, edited\n');
    const second = await build();
    const secondDir = currentDir();

    assert.equal(second.unchanged, false);
    assert.notEqual(second.version, first.version);
    assert.equal(readManifest(firstDir).version, first.version);
    assert.equal(readManifest(secondDir).version, second.version);
    assert.match(fs.readFileSync(path.join(secondDir, '.claude', 'rules', '01-demo.md'), 'utf8'), /edited/);
  });
});

test('exclude patterns drop matched files from the walk', async () => {
  await withFixture(
    async ({ build, currentDir }) => {
      const report = await build();
      assert.equal(report.ok, true, report.errors.join('; '));

      const versionDir = currentDir();
      const manifest = readManifest(versionDir);
      const paths = manifest.sources[0].files.map((file) => file.relPath);
      assert.deepEqual(paths, ['sources/demo/keep.md']);
      assert.doesNotMatch(fs.readFileSync(path.join(versionDir, '.claude', 'rules', '01-demo.md'), 'utf8'), /archived/);
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

test('exclude patterns are anchored to an out-of-base source walk root', async () => {
  await withFixture(
    async ({ build, currentDir }) => {
      const report = await build();
      assert.equal(report.ok, true, report.errors.join('; '));
      assert.deepEqual(
        readManifest(currentDir()).sources[0].files.map((file) => path.basename(file.relPath)),
        ['keep.md']
      );
    },
    {
      spec: baseSpec({ sources: [{ glob: '../docs/*.md', exclude: ['**/plan-*.md'] }] }),
      seed: (packsDir) => {
        writeFile(path.dirname(packsDir), 'docs/keep.md', 'keep me\n');
        writeFile(path.dirname(packsDir), 'docs/plan-hidden.md', 'exclude me\n');
      },
    }
  );
});

test('a leading double star glob walks from the pack base and watches that base', async () => {
  await withFixture(
    async ({ build, currentDir, packsDir }) => {
      const report = await build();
      assert.equal(report.ok, true, report.errors.join('; '));
      assert.deepEqual(
        readManifest(currentDir()).sources[0].files.map((file) => file.relPath),
        ['sources/deep/one.md']
      );
      assert.deepEqual(await packWatchRoots(baseSpec({ sources: [{ glob: '**/*.md' }] }), {
        baseDir: packsDir,
      }), [packsDir.replace(/\\/g, '/')]);
    },
    {
      spec: baseSpec({ sources: [{ glob: '**/*.md' }] }),
      seed: (packsDir) => {
        writeFile(packsDir, 'sources/deep/one.md', 'nested source\n');
        writeFile(packsDir, 'sources/deep/two.txt', 'not markdown\n');
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
        readManifest(currentDir()).sources[0].files.map((file) => file.relPath),
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
      const versionDir = currentDir();
      assert.equal(fs.readFileSync(path.join(versionDir, '.claude', 'skills', 'voice-style', 'SKILL.md'), 'utf8'), 'skill body\n');
      assert.ok(fs.existsSync(path.join(versionDir, '.claude', 'skills', 'voice-style', 'references', 'tone.md')));
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

test('a memory directory cannot be delivered as a skill', async () => {
  const spec = baseSpec({ skills: [{ dir: '{{glissaHome}}/memory/dist/current' }] });
  await withFixture(async ({ root, build, builtRoot }) => {
    const glissaHome = path.join(root, 'glissa-home');
    writeFile(glissaHome, 'memory/dist/current/MEMORY.md', 'private memory\n');
    const report = await build({ glissaHome });

    assert.equal(report.ok, false);
    assert.equal(report.errors.some((error) => error.includes('instruction-tier')), true);
    assert.equal(fs.existsSync(path.join(builtRoot, 'demo')), false);
  }, {
    spec,
    seed: (packsDir) => writeFile(packsDir, 'sources/demo/one.md', 'source\n'),
  });
});

test('a skill directory cannot escape into and overwrite the rules tree', async () => {
  const spec = baseSpec({
    sources: [{ glob: 'sources/x/*.md' }],
    skills: [{ dir: '..' }],
  });
  await withFixture(async ({ build, builtRoot }) => {
    const report = await build();

    assert.equal(report.ok, false);
    assert.equal(fs.existsSync(path.join(builtRoot, 'demo')), false);
  }, {
    spec,
    seed: (packsDir) => {
      writeFile(packsDir, 'sources/x/one.md', 'source\n');
      writeFile(path.dirname(packsDir), 'rules/01-x.md', 'overwrite\n');
    },
  });
});

test('an unfilled source template fails before publishing', async () => {
  await withFixture(async ({ build, builtRoot }) => {
    const report = await build();

    assert.equal(report.ok, false);
    assert.equal(report.errors.some((error) => error.includes('UNFILLED_TEMPLATE_STUB')), true);
    assert.equal(fs.existsSync(path.join(builtRoot, 'demo')), false);
  }, {
    seed: (packsDir) => writeFile(packsDir, 'sources/demo/one.md', '# Pending\n\n> TODO add context\n'),
  });
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
    assert.equal(readManifest(currentDir()).version, good.version);
    assert.ok(fs.existsSync(path.join(packsDir, 'specs', 'demo.pack.json')));
  });
});

test('a write failure leaves the pointed build byte-identical', async () => {
  await withFixture(async (ctx) => {
    const first = await ctx.build();
    const firstDir = ctx.currentDir();
    const pointerPath = path.join(ctx.builtRoot, 'demo', 'current', 'version');
    const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
    const indexBefore = fs.readFileSync(path.join(firstDir, 'CLAUDE.md'), 'utf8');
    writeFile(ctx.packsDir, 'sources/demo/one.md', '# One\n\nchanged\n');
    const originalOpen = fsp.open;
    fsp.open = async (target, ...args) => {
      if (String(target).includes(`${path.sep}tmp-`) && path.basename(String(target)) === 'manifest.json') {
        throw new Error('simulated mid-write failure');
      }
      return originalOpen(target, ...args);
    };
    try {
      const failed = await ctx.build();
      assert.equal(failed.ok, false);
      assert.match(failed.errors.join('; '), /simulated mid-write failure/);
    } finally {
      fsp.open = originalOpen;
    }
    const resolved = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    assert.equal(resolved.version, first.version);
    assert.ok(resolved.dir, 'the previous build is still the resolved one');
    assert.equal(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);
    assert.equal(fs.readFileSync(path.join(resolved.dir, 'CLAUDE.md'), 'utf8'), indexBefore);
  });
});

test('publishing nested outputs syncs every created ancestor directory', async (t) => {
  if (process.platform === 'win32') t.skip('directory sync is unsupported on Windows');
  const builtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-sync-'));
  const originalOpen = fsp.open;
  const syncedDirectories: string[] = [];
  t.mock.method(fsp, 'open', async (target: fs.PathLike, ...args: never[]) => {
    if (String(args[0]) === 'r') syncedDirectories.push(path.resolve(String(target)));
    return originalOpen(target, ...args);
  });
  try {
    await publishBuild(builtRoot, 'demo', [{ relPath: 'a/b/c/file.md', content: 'nested' }]);
    const temporaryDirectory = syncedDirectories.find((directory) => path.basename(directory).startsWith('tmp-'));
    if (!temporaryDirectory) throw new Error('the publish synced no temporary directory');
    assert.deepEqual(
      [
        temporaryDirectory,
        path.join(temporaryDirectory, 'a'),
        path.join(temporaryDirectory, 'a', 'b'),
        path.join(temporaryDirectory, 'a', 'b', 'c'),
      ].sort(),
      syncedDirectories.filter((directory) => directory === temporaryDirectory || directory.startsWith(`${temporaryDirectory}${path.sep}`)).sort()
    );
  } finally {
    fs.rmSync(builtRoot, { recursive: true, force: true });
  }
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
    const stale = path.join(builtRoot, 'demo', 'tmp-2147483647-deadbeef');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'junk.md'), 'junk', 'utf8');

    const report = await build();
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.equal(fs.existsSync(stale), false);
    assert.deepEqual(fs.readdirSync(path.join(builtRoot, 'demo')).sort(), ['current', 'versions']);
  });
});

test('a reclaimed publish lock from a crashed cleanup is swept before the next build', async () => {
  await withFixture(async ({ build, builtRoot }) => {
    const reclaimed = path.join(builtRoot, 'demo', `publish.lock.reclaimed-${process.pid}-1`);
    fs.mkdirSync(path.dirname(reclaimed), { recursive: true });
    fs.writeFileSync(reclaimed, 'abandoned lock', 'utf8');

    const report = await build();
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.equal(fs.existsSync(reclaimed), false);
  });
});

test('two publishers racing serialize cleanup and pointer flips', async () => {
  const builtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-publish-race-'));
  const firstOutputs = [
    { relPath: 'owner.txt', content: 'first' },
    { relPath: 'payload.txt', content: 'a'.repeat(2 * 1024 * 1024) },
  ];
  const secondOutputs = [
    { relPath: 'owner.txt', content: 'second' },
    { relPath: 'payload.txt', content: 'b'.repeat(2 * 1024 * 1024) },
  ];
  try {
    await Promise.all([
      publishBuild(builtRoot, 'demo', firstOutputs),
      publishBuild(builtRoot, 'demo', secondOutputs),
    ]);

    const packDir = path.join(builtRoot, 'demo');
    const publishedOwners = fs.readdirSync(path.join(packDir, 'versions'))
      .map((version) => fs.readFileSync(path.join(packDir, 'versions', version, 'owner.txt'), 'utf8'))
      .sort();
    assert.deepEqual(publishedOwners, ['first', 'second']);
    assert.equal(fs.existsSync(path.join(packDir, 'publish.lock')), false);
    assert.equal(fs.readdirSync(packDir).some((name) => name.startsWith('tmp-')), false);
  } finally {
    fs.rmSync(builtRoot, { recursive: true, force: true });
  }
});

test('a publish lock owned by a dead process is reclaimed', async () => {
  const builtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-stale-lock-'));
  const packDir = path.join(builtRoot, 'demo');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'publish.lock'), `${JSON.stringify({
    pid: 2147483647,
    timestamp: Date.now(),
    token: 'abandoned',
  })}\n`, 'utf8');
  try {
    await publishBuild(builtRoot, 'demo', [{ relPath: 'owner.txt', content: 'reclaimed' }]);
    assert.equal(fs.readFileSync(path.join(currentVersionDir(builtRoot, 'demo'), 'owner.txt'), 'utf8'), 'reclaimed');
    assert.equal(fs.existsSync(path.join(packDir, 'publish.lock')), false);
  } finally {
    fs.rmSync(builtRoot, { recursive: true, force: true });
  }
});

test('a waiter keeps retrying after the prior lock wait while its live owner holds the lock', async () => {
  const builtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-live-lock-'));
  const packDir = path.join(builtRoot, 'demo');
  const lockPath = path.join(packDir, 'publish.lock');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    timestamp: Date.now(),
    token: 'live-owner',
  })}\n`, 'utf8');

  try {
    let nowMs = Date.now();
    let sleepCount = 0;
    const currentDir = await publishBuild(builtRoot, 'demo', [{ relPath: 'owner.txt', content: 'waited' }], {
      now: () => nowMs,
      sleep: async (ms) => {
        assert.equal(ms, 20);
        sleepCount += 1;
        nowMs += ms;
        if (sleepCount !== 2) return;
        fs.rmSync(lockPath, { force: true });
      },
    });
    assert.equal(sleepCount, 2);
    assert.equal(fs.readFileSync(path.join(currentDir, 'owner.txt'), 'utf8'), 'waited');
  } finally {
    fs.rmSync(builtRoot, { recursive: true, force: true });
  }
});

test('a publish failure survives a release failure', async () => {
  const builtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-release-failure-'));
  const packDir = path.join(builtRoot, 'demo');
  const lockPath = path.join(packDir, 'publish.lock');
  const originalRename = fsp.rename;
  const originalUnlink = fsp.unlink;
  const originalError = console.error;
  const releaseErrors: string[] = [];
  fsp.rename = async (source, destination) => {
    if (destination === path.join(packDir, 'current', 'version')) throw new Error('pointer flip failed');
    return originalRename(source, destination);
  };
  fsp.unlink = async (target) => {
    if (target === lockPath) throw new Error('release failed');
    return originalUnlink(target);
  };
  console.error = (message: unknown) => { releaseErrors.push(String(message)); };

  try {
    await assert.rejects(
      publishBuild(builtRoot, 'demo', [{ relPath: 'owner.txt', content: 'broken' }]),
      /pointer flip failed/
    );
    assert.equal(releaseErrors.length, 1);
    assert.match(releaseErrors[0], /release failed/);
  } finally {
    fsp.rename = originalRename;
    fsp.unlink = originalUnlink;
    console.error = originalError;
    fs.rmSync(builtRoot, { recursive: true, force: true });
  }
});

test('two publishers atomically contend to reclaim one stale lock', async () => {
  const builtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-reclaim-race-'));
  const packDir = path.join(builtRoot, 'demo');
  const lockPath = path.join(packDir, 'publish.lock');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: 2147483647,
    timestamp: Date.now(),
    token: 'abandoned',
  })}\n`, 'utf8');

  const originalRename = fsp.rename;
  const reclaimTargets: string[] = [];
  const rename: { releaseFirst: (() => void) | null } = { releaseFirst: null };
  const secondRenameReached = new Promise<void>((resolve) => {
    rename.releaseFirst = () => resolve();
  });
  fsp.rename = async (source, destination) => {
    if (source !== lockPath) return originalRename(source, destination);
    reclaimTargets.push(String(destination));
    if (reclaimTargets.length === 1) await secondRenameReached;
    if (reclaimTargets.length === 2 && rename.releaseFirst) rename.releaseFirst();
    return originalRename(source, destination);
  };

  try {
    await Promise.all([
      publishBuild(builtRoot, 'demo', [{ relPath: 'owner.txt', content: 'first' }]),
      publishBuild(builtRoot, 'demo', [{ relPath: 'owner.txt', content: 'second' }]),
    ]);
    const publishedOwners = fs.readdirSync(path.join(packDir, 'versions'))
      .map((version) => fs.readFileSync(path.join(packDir, 'versions', version, 'owner.txt'), 'utf8'))
      .sort();
    assert.deepEqual(publishedOwners, ['first', 'second']);
    assert.equal(reclaimTargets.length, 2);
    assert.equal(new Set(reclaimTargets).size, 2);
    assert.equal(fs.readdirSync(packDir).some((name) => name.startsWith('publish.lock')), false);
  } finally {
    fsp.rename = originalRename;
    fs.rmSync(builtRoot, { recursive: true, force: true });
  }
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

test('buildPacks reports one publish failure and continues with later specs', async () => {
  await withFixture(async ({ packsDir, specsDir, builtRoot }) => {
    writeSpec(packsDir, 'alpha', baseSpec({ name: 'alpha' }));
    writeFile(builtRoot, 'alpha', 'blocks the pack directory');

    const reports = await buildPacks({ specsDir, baseDir: packsDir, builtRoot });

    assert.deepEqual(reports.map((report) => report.name), ['alpha', 'demo']);
    assert.equal(reports[0].ok, false);
    assert.equal(reports[0].errors.some((error) => error.includes('could not publish pack')), true);
    assert.equal(reports[1].ok, true, reports[1].errors.join('; '));
    assert.equal(fs.existsSync(path.join(builtRoot, 'demo', 'current')), true);
  });
});

test('duplicate skill output paths fail without publishing a pack', async () => {
  const spec = baseSpec({
    skills: [{ dir: 'skills/alpha/shared' }, { dir: 'skills/beta/shared' }],
  });
  await withFixture(async ({ build, builtRoot }) => {
    const report = await build();
    assert.equal(report.ok, false);
    assert.match(report.errors.join('; '), /skills\/alpha\/shared/);
    assert.match(report.errors.join('; '), /skills\/beta\/shared/);
    assert.equal(fs.existsSync(path.join(builtRoot, 'demo')), false);
  }, {
    spec,
    seed: (packsDir) => {
      writeFile(packsDir, 'sources/demo/one.md', 'source\n');
      writeFile(packsDir, 'skills/alpha/shared/SKILL.md', 'first skill\n');
      writeFile(packsDir, 'skills/beta/shared/SKILL.md', 'second skill\n');
    },
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
    assert.equal(manifest?.version, report.version);
  });
});

test('every spec the repo ships builds from its own spec file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-proof-pack-'));
  try {
    const specs = await listPackSpecs({ specsDir: path.join(import.meta.dirname, '..', 'packs', 'specs') });
    assert.ok(specs.length > 0);
    for (const spec of specs) {
      const report = await buildPack({ specPath: spec.specPath, builtRoot: root, glissaHome: path.join(root, 'home') });
      assert.equal(report.ok, true, `${spec.name}: ${report.errors.join('; ')}`);
      assert.ok(report.budgetTokens !== null && report.tokenEstimate <= report.budgetTokens);
      assert.ok(report.currentDir !== null && fs.existsSync(path.join(report.currentDir, 'CLAUDE.md')));
    }
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
    assert.equal(resolved.dir, ctx.currentDir());
    assert.equal(resolved.version, built.version);
    assert.equal(resolved.reason, null);
  });
});

test('resolveBuiltPack skips an unbuilt pack, a manifest-less dir, and a path-escaping name', async () => {
  await withFixture(async (ctx) => {
    const unbuilt = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    assert.equal(unbuilt.dir, null);
    assert.match(String(unbuilt.reason), /not built/);

    await ctx.build();
    fs.rmSync(path.join(ctx.currentDir(), 'manifest.json'));
    const manifestless = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    assert.equal(manifestless.dir, null);
    assert.match(String(manifestless.reason), /manifest\.json/);

    const escaping = await resolveBuiltPack('../../etc', { builtRoot: ctx.builtRoot });
    assert.equal(escaping.dir, null);
    assert.match(String(escaping.reason), /valid pack name/);
  });
});

test('a crash after the version directory rename leaves the old pointer live', async () => {
  await withFixture(async (ctx) => {
    const firstBuild = await ctx.build();
    const first = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    const packDir = path.join(ctx.builtRoot, 'demo');
    const pointerPath = path.join(packDir, 'current', 'version');
    const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
    writeFile(ctx.packsDir, 'sources/demo/one.md', '# One\n\nnew bytes\n');
    const originalRename = fsp.rename;
    fsp.rename = async (source, destination) => {
      if (destination === pointerPath) throw new Error('simulated crash before pointer flip');
      return originalRename(source, destination);
    };
    try {
      const failed = await ctx.build();
      assert.equal(failed.ok, false);
    } finally {
      fsp.rename = originalRename;
    }
    const stillCurrent = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    assert.equal(stillCurrent.dir, first.dir);
    assert.equal(stillCurrent.version, firstBuild.version);
    assert.equal(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);
    assert.equal(fs.readdirSync(path.join(packDir, 'versions')).length, 2);
  });
});

test('version GC retains two directories and never removes the pointed version', async () => {
  await withFixture(async (ctx) => {
    for (const content of ['first', 'second', 'third']) {
      writeFile(ctx.packsDir, 'sources/demo/one.md', `# One\n\n${content}\n`);
      const report = await ctx.build();
      assert.equal(report.ok, true, report.errors.join('; '));
    }
    const packDir = path.join(ctx.builtRoot, 'demo');
    const pointedVersion = fs.readFileSync(path.join(packDir, 'current', 'version'), 'utf8').trim();
    const retainedVersions = fs.readdirSync(path.join(packDir, 'versions')).sort();
    assert.equal(retainedVersions.length, 2);
    assert.equal(retainedVersions.includes(pointedVersion), true);
    assert.equal(fs.existsSync(path.join(packDir, 'versions', pointedVersion, 'manifest.json')), true);
  });
});

test('a missing pointed version is refused without a previous fallback', async () => {
  await withFixture(async (ctx) => {
    await ctx.build();
    fs.rmSync(ctx.currentDir(), { recursive: true, force: true });
    const skipped = await resolveBuiltPack('demo', { builtRoot: ctx.builtRoot });
    assert.equal(skipped.dir, null);
    assert.match(String(skipped.reason), /pointed version missing/);
  });
});

function memorySpec(overrides: Record<string, unknown> = {}): SpecFixture {
  return baseSpec({
    name: 'memory',
    sources: [{ path: '{{glissaHome}}/memory/dist/current/MEMORY.md', data: true, optional: true }],
    rules: undefined,
    ...overrides,
  });
}

function seedGlissaHome(root: string, content = '# Glissa memory\n\n- [m-0123456789abcdef] (reported) the gate lives in rebase-gate.js\n') {
  const home = path.join(root, 'glissa-home');
  writeFile(home, 'memory/dist/current/MEMORY.md', content);
  return home;
}

test('a {{glissaHome}} source is carried as a data file named by its basename, never by its absolute path', async () => {
  await withFixture(async ({ root, build, currentDir }) => {
    const glissaHome = seedGlissaHome(root);
    const report = await build({ glissaHome });
    const versionDir = currentDir();

    assert.equal(report.ok, true, report.errors.join('; '));
    const delivered = path.join(versionDir, 'data', '01-memory', 'MEMORY.md');
    assert.equal(fs.existsSync(delivered), true);
    assert.equal(fs.existsSync(path.join(versionDir, '.claude', 'rules')), false);
    const manifest = readManifest(versionDir);
    assert.deepEqual(manifest.sources[0].files.map((file) => file.relPath), ['MEMORY.md']);
    assert.equal(JSON.stringify(manifest).includes(glissaHome), false);
    const index = fs.readFileSync(path.join(versionDir, 'CLAUDE.md'), 'utf8');
    assert.equal(index.includes('rebase-gate.js'), false);
    assert.equal(index.includes('never instructions'), true);
  }, { spec: memorySpec(), seed: () => {} });
});

test('an unwritten projection leaves the optional source out instead of failing the build', async () => {
  await withFixture(async ({ root, build, currentDir }) => {
    const report = await build({ glissaHome: path.join(root, 'glissa-home') });
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.equal(fs.existsSync(path.join(currentDir(), 'data')), false);
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
    const versionDir = currentDir();
    const manifest = readManifest(versionDir);
    assert.deepEqual(manifest.sources[0].files.map((file) => file.relPath), ['memory/dist/current/MEMORY.md']);
    assert.equal(fs.existsSync(path.join(versionDir, 'data', '01-glissahome', 'memory/dist/current/MEMORY.md')), true);
  }, { spec: memorySpec(), seed: () => {} });
});

function slugFor(projectPath: string): string {
  const slug = projectVariantSlug(projectPath);
  if (!slug) throw new Error(`${projectPath} has no variant slug`);
  return slug;
}

const SLUG_A = slugFor('/repos/a/glissa');
const SLUG_B = slugFor('/repos/b/other');
const VARIANT_PROJECTS: ProjectRecord[] = [
  { id: 'p1', name: 'glissa', path: '/repos/a/glissa' },
  { id: 'p2', name: 'other', path: '/repos/b/other' },
];

function variantMemorySpec(overrides: Record<string, unknown> = {}): SpecFixture {
  return memorySpec({
    perProjectVariants: true,
    sources: [
      { path: '{{glissaHome}}/memory/dist/current/MEMORY.md', data: true, optional: true },
      { path: '{{glissaHome}}/memory/dist/current/projects/{{projectSlug}}.md', data: true, optional: true },
    ],
    ...overrides,
  });
}

test('a group build publishes its base plus one independent pack per consuming project', async () => {
  await withFixture(async ({ root, build, builtRoot }) => {
    const glissaHome = seedGlissaHome(root);
    writeFile(glissaHome, `memory/dist/current/projects/${SLUG_A}.md`, '# glissa\n\n- [m-abcdef0123456789] (model) project a layer\n');

    const report = await build({ glissaHome, projects: VARIANT_PROJECTS });
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.deepEqual(report.variants.map((variant) => variant.name), [`memory-${SLUG_A}`, `memory-${SLUG_B}`]);
    assert.equal(report.variants.every((variant) => variant.ok), true);

    const variantDir = currentVersionDir(builtRoot, `memory-${SLUG_A}`);
    const baseDir = currentVersionDir(builtRoot, 'memory');
    const otherVariantDir = currentVersionDir(builtRoot, `memory-${SLUG_B}`);
    const variantManifest = readManifest(variantDir);
    assert.equal(variantManifest.name, `memory-${SLUG_A}`);
    assert.equal(variantManifest.group, 'memory');
    assert.equal(variantManifest.projectId, 'p1');
    assert.notEqual(variantManifest.version, readManifest(baseDir).version);

    const ownLayer = path.join(variantDir, 'data', `02-${SLUG_A}`, `${SLUG_A}.md`);
    assert.equal(fs.existsSync(ownLayer), true);
    assert.equal(fs.existsSync(path.join(baseDir, 'data', `02-${SLUG_A}`)), false);
    assert.equal(fs.existsSync(path.join(otherVariantDir, 'data', `02-${SLUG_A}`)), false);
  }, { spec: variantMemorySpec(), seed: () => {} });
});

test('a project with no layer yet still gets a variant: a missing per-project source is skipped, not an error', async () => {
  await withFixture(async ({ root, build, builtRoot }) => {
    const glissaHome = seedGlissaHome(root);
    const report = await build({ glissaHome, projects: VARIANT_PROJECTS });

    assert.equal(report.ok, true, report.errors.join('; '));
    assert.equal(report.variants.every((variant) => variant.ok), true, report.variants.map((v) => v.errors.join('; ')).join(' | '));
    const manifest = readManifest(currentVersionDir(builtRoot, `memory-${SLUG_B}`));
    assert.deepEqual(manifest.sources.map((source) => source.dataDir), ['data/01-memory']);
  }, { spec: variantMemorySpec(), seed: () => {} });
});

test('the group base declares perProjectVariants, which is what a spawn resolves a variant from', async () => {
  await withFixture(async ({ root, build, builtRoot }) => {
    const glissaHome = seedGlissaHome(root);
    await build({ glissaHome, projects: VARIANT_PROJECTS });

    const base = await resolveBuiltPack('memory', { builtRoot });
    assert.equal(base.perProjectVariants, true);
    assert.equal(base.group, null);
    const variant = await resolveBuiltPack(`memory-${SLUG_A}`, { builtRoot });
    assert.equal(variant.perProjectVariants, false);
    assert.equal(variant.group, 'memory');
  }, { spec: variantMemorySpec(), seed: () => {} });
});


test('a rebuild that changes nothing republishes no variant either', async () => {
  await withFixture(async ({ root, build, builtRoot }) => {
    const glissaHome = seedGlissaHome(root);
    writeFile(glissaHome, `memory/dist/current/projects/${SLUG_A}.md`, '# glissa\n\n- [m-abcdef0123456789] (model) project a layer\n');
    await build({ glissaHome, projects: VARIANT_PROJECTS });
    const again = await build({ glissaHome, projects: VARIANT_PROJECTS });

    assert.equal(again.unchanged, true);
    assert.equal(again.variants.every((variant) => variant.unchanged), true);
    assert.equal(fs.readdirSync(path.join(builtRoot, `memory-${SLUG_A}`, 'versions')).length, 1);
  }, { spec: variantMemorySpec(), seed: () => {} });
});

test('buildPacks lists every derived pack beside its group', async () => {
  await withFixture(async ({ root, packsDir, specsDir, builtRoot }) => {
    const glissaHome = seedGlissaHome(root);
    const reports = await buildPacks({ specsDir, baseDir: packsDir, builtRoot, glissaHome, projects: VARIANT_PROJECTS });
    assert.deepEqual(reports.map((report) => report.name), ['memory', `memory-${SLUG_A}`, `memory-${SLUG_B}`]);
  }, { spec: variantMemorySpec(), seed: () => {} });
});

test('a per-project pattern is watched as a wildcard, so a first layer file is seen', async () => {
  await withFixture(async ({ root }) => {
    const glissaHome = seedGlissaHome(root);
    fs.mkdirSync(path.join(glissaHome, 'memory/dist/current/projects'), { recursive: true });
    const roots = await packWatchRoots(variantMemorySpec(), { baseDir: path.join(root, 'packs'), glissaHome });
    assert.deepEqual(roots, [
      path.join(glissaHome, 'memory/dist/current').replace(/\\/g, '/'),
      path.join(glissaHome, 'memory/dist/current/projects').replace(/\\/g, '/'),
    ]);
  }, { spec: variantMemorySpec(), seed: () => {} });
});

test('a variant that would carry another project layer fails and publishes nothing', async () => {
  const spec = memorySpec({
    perProjectVariants: true,
    sources: [
      { path: '{{glissaHome}}/memory/dist/current/projects/{{projectSlug}}.md', data: true, optional: true },
      { glob: '{{glissaHome}}/memory/dist/current/projects/*.md', data: true, optional: true },
    ],
  });
  await withFixture(async ({ root, build, builtRoot }) => {
    const glissaHome = seedGlissaHome(root);
    writeFile(glissaHome, `memory/dist/current/projects/${SLUG_A}.md`, '# a\n\nlayer a\n');
    writeFile(glissaHome, `memory/dist/current/projects/${SLUG_B}.md`, '# b\n\nlayer b\n');

    const report = await build({ glissaHome, projects: VARIANT_PROJECTS });
    const variant = report.variants.find((entry) => entry.name === `memory-${SLUG_A}`);
    if (!variant) throw new Error('the group build planned no variant for this project');
    assert.equal(variant.ok, false);
    assert.equal(variant.errors.some((error) => error.includes(SLUG_B)), true);
    assert.equal(fs.existsSync(path.join(builtRoot, `memory-${SLUG_A}`, 'current')), false);
  }, { spec, seed: () => {} });
});

test('a variant rejects a retired project layer selected by an exclude placeholder', async () => {
  const retiredSlug = 'retired-12345678';
  const spec = memorySpec({
    perProjectVariants: true,
    sources: [
      { path: '{{glissaHome}}/memory/dist/current/MEMORY.md', data: true, optional: true },
      {
        glob: '{{glissaHome}}/memory/dist/current/projects/*.md',
        exclude: ['{{glissaHome}}/memory/dist/current/projects/{{projectSlug}}.md'],
        data: true,
        optional: true,
      },
    ],
  });
  await withFixture(async ({ root, build, builtRoot }) => {
    const glissaHome = seedGlissaHome(root);
    writeFile(glissaHome, `memory/dist/current/projects/${retiredSlug}.md`, 'retired layer\n');
    const report = await build({ glissaHome, projects: [VARIANT_PROJECTS[0]] });
    const variant = report.variants.find((entry) => entry.name === `memory-${SLUG_A}`);
    if (!variant) throw new Error('the group build planned no variant for this project');
    assert.equal(variant.ok, false);
    assert.equal(variant.errors.some((error) => error.includes(retiredSlug) && error.includes(SLUG_A)), true);
    assert.equal(fs.existsSync(path.join(builtRoot, `memory-${SLUG_A}`, 'current')), false);
  }, { spec, seed: () => {} });
});

test('the manifest records every source root packs-relative, distill sources included', async () => {
  const spec = baseSpec({
    sources: [{ glob: 'sources/demo/**/*.md' }],
    distill: [{ output: 'sources/demo/derived/brief.md', sources: [{ path: '../AGENTS.md' }], instructions: 'summarize' }],
  });
  await withFixture(async ({ build, currentDir, root }) => {
    const report = await build();
    assert.equal(report.ok, true, report.errors.join('; '));
    const manifest = readManifest(currentDir());
    assert.deepEqual(manifest.sourceRoots, ['../AGENTS.md', 'sources/demo']);
    assert.equal(JSON.stringify(manifest).includes(root), false, 'a manifest ships inside the pack, so it carries no absolute path');
  }, { spec });
});

test('a source root under the Glissa config dir is left out of the manifest entirely', async () => {
  await withFixture(async ({ root, build, currentDir }) => {
    const glissaHome = seedGlissaHome(root);
    const report = await build({ glissaHome });
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.deepEqual(readManifest(currentDir()).sourceRoots, []);
  }, { spec: memorySpec(), seed: () => {} });
});

test('packSourceRoots resolves sources, skills and distill sources absolute', async () => {
  const spec = baseSpec({
    skills: [{ dir: 'skills/voice-style' }],
    distill: [{ output: 'sources/demo/derived/brief.md', sources: [{ glob: '../docs/*.md' }], instructions: 'summarize' }],
  });
  await withFixture(async ({ packsDir }) => {
    const roots = await packSourceRoots(spec, { baseDir: packsDir });
    const relative = roots.map((root) => path.relative(packsDir, root).replace(/\\/g, '/'));
    assert.deepEqual(relative.sort(), ['../docs', 'skills/voice-style', 'sources/demo']);
  }, { spec });
});
