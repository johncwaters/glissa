import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import type { GlissaConfig, ProjectEntry } from '../server/config-store.ts';
import { createSessionFactory } from '../server/session-factory.ts';

const PROJECT: ProjectEntry = { id: 'p1', name: 'glissa', path: path.join(os.tmpdir(), 'glissa-factory-probe') };

function configWith(overrides: Partial<GlissaConfig>): GlissaConfig {
  return { ...DEFAULT_CONFIG, projects: [PROJECT], teams: [], repoRoots: [], ...overrides } as GlissaConfig;
}

function factory(listPackNames: () => string[], liveConfig: GlissaConfig) {
  return createSessionFactory({
    configStore: { configPath: path.join(os.tmpdir(), 'glissa-factory-probe', 'config.json') },
    getConfig: () => liveConfig,
    hookRouter: null,
    getHookPort: () => null,
    getGitWorkspace: () => null,
    getMillMetricsPort: () => null,
    rtkPathForConfig: () => null,
    getUserHooks: () => [],
    listPackNames,
  });
}

function sessionFor(listPackNames: () => string[], config: GlissaConfig, project: ProjectEntry = PROJECT) {
  return factory(listPackNames, config)(project, config);
}

test('with the mill on a spawn is handed every spec on disk, no per-project list needed', () => {
  const session = sessionFor(() => ['memory', 'house-rules'], configWith({ millEnabled: true }));
  assert.deepEqual(session.packNames, ['memory', 'house-rules']);
});

test('with the mill off a spawn is handed no packs at all', () => {
  const session = sessionFor(() => ['memory'], configWith({ millEnabled: false }));
  assert.deepEqual(session.packNames, []);
});

test('a stale packs key on the project record is not what a spawn reads', () => {
  const stale = { ...PROJECT, packs: ['ghost'] };
  const session = sessionFor(() => ['memory'], configWith({}), stale);
  assert.deepEqual(session.packNames, ['memory']);
});

test('a mill flip on the live config lands on the next spawn, with no session recreate', async () => {
  const liveConfig = configWith({ millEnabled: true });
  const session = sessionFor(() => ['memory'], liveConfig);
  assert.deepEqual(session.packNames, ['memory']);

  liveConfig.millEnabled = false;
  await session._resolvePacks();
  assert.deepEqual(session.packNames, []);

  liveConfig.millEnabled = true;
  await session._resolvePacks();
  assert.deepEqual(session.packNames, ['memory']);
});

test('a spec built after the session was made is delivered by the next spawn', async () => {
  let specsOnDisk = ['memory'];
  const session = sessionFor(() => [...specsOnDisk], configWith({ millEnabled: true }));

  specsOnDisk = ['house-rules', 'memory'];
  await session._resolvePacks();

  assert.deepEqual(session.packNames, ['house-rules', 'memory']);
});
