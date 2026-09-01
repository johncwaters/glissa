import test from 'node:test';
import assert from 'node:assert/strict';

import type { GlissaConfig, ProjectEntry } from '../server/config-store.ts';
import type { ControlHandlerDeps } from '../server/control-handlers.ts';
import type { ControlMessageRecord } from '../server/control-replay-core.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';

const SPECS = ['crew-rules', 'house-rules', 'a', 'b', 'c', 'd', 'e'];

interface PacksFrame {
  type: string;
  requestId?: string;
  ok?: boolean;
  error?: string;
  packs?: string[];
}

interface PacksHarnessOptions {
  specs?: string[];
  onReload?: (() => void) | null;
  ensurePacksBuilt?: ControlHandlerDeps['ensurePacksBuilt'];
  packSourceRoots?: Record<string, string[]> | null;
  saveFails?: boolean;
  saveTarget?: GlissaConfig;
  omitListPackNames?: boolean;
}

function harness(config: GlissaConfig, options: PacksHarnessOptions = {}) {
  const { specs = SPECS, onReload = null, ensurePacksBuilt, packSourceRoots = null } = options;
  const broadcasts: ControlMessageRecord[] = [];
  const saveCalls: number[] = [];
  const reloads: GlissaConfig[] = [];

  const events: string[] = [];
  const builds: string[] = [];

  const server = createControlServer(controlDeps(config, {
    configStore: testConfigStore(options.saveTarget ?? config, {
      saveFails: options.saveFails === true,
      onSave: () => saveCalls.push(1),
    }),
    applyConfigReload: (fresh) => {
      events.push('reload');
      reloads.push(fresh);
      if (onReload) onReload();
    },
    broadcastControl: (message) => {
      if (message.type === 'project-packs-updated') events.push('broadcast');
      broadcasts.push(message);
    },
    listPackNames: options.omitListPackNames === true ? null : async () => specs,
    resolvePackSourceRoots: packSourceRoots ? async (name: string) => packSourceRoots[name] || [] : null,
    ensurePacksBuilt: ensurePacksBuilt || (async (names: string[]) => { events.push('build'); builds.push(...names); }),
  }));

  const connection = connectControl<PacksFrame>(server);
  connection.sent.length = 0;
  return {
    send: connection.send,
    sent: connection.sent,
    broadcasts, saveCalls, reloads, events, builds,
  };
}

function project(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return { id: 'p1', name: 'glissa', path: 'C:/repo', ...overrides };
}

function resultOf(h: { sent: PacksFrame[] }): PacksFrame | undefined {
  return h.sent.find((m) => m.type === 'set-project-packs-result');
}

test('delivering a pack persists it on the project record and reloads like a hand edit', async () => {
  const config: GlissaConfig = { projects: [project()] };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', requestId: 'r1', projectId: 'p1', pack: 'crew-rules', deliver: true });

  assert.deepEqual(config.projects[0].packs, ['crew-rules']);
  assert.equal(h.reloads.length, 1, 'the same reload a config.json edit takes');
  const result = resultOf(h);
  assert.equal(result?.ok, true);
  assert.equal(result?.requestId, 'r1');
  assert.deepEqual(result?.packs, ['crew-rules']);
  const broadcast = h.broadcasts.find((m) => m.type === 'project-packs-updated');
  assert.deepEqual(broadcast?.packs, ['crew-rules']);
});

test('a newly delivered pack is built BEFORE the reload that recreates the session', async () => {
  const config: GlissaConfig = { projects: [project()] };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: true });

  assert.deepEqual(h.builds, ['crew-rules']);
  assert.ok(h.events.indexOf('build') < h.events.indexOf('reload'),
    `build must precede reload, got ${h.events.join(' -> ')}`);
});

test('the build is awaited, so a slow build still lands before the reload', async () => {
  const config: GlissaConfig = { projects: [project()] };
  const order: string[] = [];
  const h = harness(config, {
    onReload: () => order.push('reload'),
    ensurePacksBuilt: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('build');
    },
  });

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: true });

  assert.deepEqual(order, ['build', 'reload']);
});

test('a removal builds nothing: there is no new delivery to prepare', async () => {
  const config: GlissaConfig = { projects: [project({ packs: ['crew-rules'] })] };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: false });

  assert.equal('packs' in config.projects[0], false, 'an emptied list removes the key');
  assert.deepEqual(h.builds, []);
});

test('the delta is applied to the list read inside the write, not to a client snapshot', async () => {
  const config: GlissaConfig = { projects: [project({ packs: ['house-rules'] })] };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: true });

  assert.deepEqual(config.projects[0].packs, ['house-rules', 'crew-rules'],
    'a concurrent edit this client never saw survives the toggle');
});

test('a project already naming a deleted spec can still be edited', async () => {
  const config: GlissaConfig = { projects: [project({ packs: ['ghost'] })] };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: true });
  assert.deepEqual(config.projects[0].packs, ['ghost', 'crew-rules']);
  assert.equal(resultOf(h)?.ok, true);

  h.sent.length = 0;
  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'ghost', deliver: false });
  assert.deepEqual(config.projects[0].packs, ['crew-rules'], 'and the ghost itself can be removed');
  assert.equal(resultOf(h)?.ok, true);
});

test('delivering a pack twice is idempotent rather than a duplicate entry', async () => {
  const config: GlissaConfig = { projects: [project({ packs: ['crew-rules'] })] };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: true });

  assert.deepEqual(config.projects[0].packs, ['crew-rules']);
  assert.equal(resultOf(h)?.ok, true);
});

test('a delta on one card moves every card sharing that checkout', async () => {
  const config: GlissaConfig = {
    projects: [project(), project({ id: 'p2', name: 'glissa (2)' }), project({ id: 'p3', name: 'other', path: 'C:/other' })],
  };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p2', pack: 'crew-rules', deliver: true });

  assert.deepEqual(config.projects[0].packs, ['crew-rules']);
  assert.deepEqual(config.projects[1].packs, ['crew-rules']);
  assert.equal('packs' in config.projects[2], false, 'another checkout is untouched');
  assert.deepEqual(resultOf(h)?.packs, ['crew-rules'], 'the addressed record is what the reply reports');
});

test('a removal on one card clears every card sharing that checkout', async () => {
  const config: GlissaConfig = {
    projects: [
      project({ packs: ['crew-rules', 'house-rules'] }),
      project({ id: 'p2', name: 'glissa (2)', packs: ['crew-rules'] }),
    ],
  };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: false });

  assert.deepEqual(config.projects[0].packs, ['house-rules']);
  assert.equal('packs' in config.projects[1], false, 'an emptied list removes the key on the sibling too');
});

test('a sibling at the cap refuses the whole delta, leaving every record alone', async () => {
  const config: GlissaConfig = {
    projects: [
      project({ packs: ['a', 'b'] }),
      project({ id: 'p2', name: 'glissa (2)', packs: ['a', 'b', 'c', 'd'] }),
    ],
  };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'e', deliver: true });

  assert.deepEqual(config.projects[0].packs, ['a', 'b'], 'the addressed record is not written half way');
  assert.deepEqual(config.projects[1].packs, ['a', 'b', 'c', 'd']);
  assert.equal(h.reloads.length, 0);
  assert.match(String(resultOf(h)?.error), /at most 4 packs/);
});

test('codex cards on one checkout share fan-out and the strictest sibling cap', async () => {
  const config: GlissaConfig = {
    projects: [
      project({ agent: 'codex', packs: ['a'] }),
      project({ id: 'p2', name: 'glissa codex 2', agent: 'codex', packs: ['a', 'b', 'c', 'd'] }),
    ],
  };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'e', deliver: true });
  assert.deepEqual(config.projects.map((record) => record.packs), [['a'], ['a', 'b', 'c', 'd']]);
  assert.match(String(resultOf(h)?.error), /at most 4 packs/);

  h.sent.length = 0;
  await h.send({ type: 'set-project-packs', projectId: 'p2', pack: 'a', deliver: false });
  assert.equal('packs' in config.projects[0], false);
  assert.deepEqual(config.projects[1].packs, ['b', 'c', 'd']);
  assert.equal(resultOf(h)?.ok, true);
});

test('a record with no path is alone: nothing marks another record as its sibling', async () => {
  const config: GlissaConfig = { projects: [project({ path: '' }), project({ id: 'p2', name: 'other', path: '' })] };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: true });

  assert.deepEqual(config.projects[0].packs, ['crew-rules']);
  assert.equal('packs' in config.projects[1], false);
});

test('an unknown project changes nothing', async () => {
  const config: GlissaConfig = { projects: [project()] };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'nope', pack: 'crew-rules', deliver: true });

  assert.equal(h.saveCalls.length, 0);
  assert.equal(h.reloads.length, 0);
  assert.deepEqual(h.broadcasts, []);
  assert.match(String(resultOf(h)?.error), /Unknown project/);
});

test('a project that vanished between the check and the write is refused, never reported ok', async () => {
  const config: GlissaConfig = { projects: [project()] };

  const h = harness(config, { saveTarget: { projects: [] } });

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: true });

  assert.deepEqual(h.reloads, []);
  const result = resultOf(h);
  assert.equal(result?.ok, false);
  assert.match(String(result?.error), /Unknown project/);
});

test('a malformed pack name or a non-boolean deliver changes nothing', async () => {
  const config: GlissaConfig = { projects: [project()] };
  const h = harness(config);

  for (const msg of [
    { pack: '../escape', deliver: true },
    { pack: '', deliver: true },
    { pack: 42, deliver: true },
    { pack: 'crew-rules', deliver: 'yes' },
    { pack: 'crew-rules' },
  ]) {
    await h.send({ type: 'set-project-packs', projectId: 'p1', ...msg });
  }

  assert.equal(h.saveCalls.length, 0);
  assert.equal('packs' in config.projects[0], false);
});

test('a pack name no spec file defines is refused before anything is written', async () => {
  const config: GlissaConfig = { projects: [project()] };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'ghost', deliver: true });

  assert.equal(h.saveCalls.length, 0);
  assert.equal(h.reloads.length, 0);
  assert.deepEqual(h.builds, []);
  assert.match(String(resultOf(h)?.error), /No pack spec named "ghost"/);
});

test('a delivery past the per-project cap is refused and the record is left alone', async () => {
  const config: GlissaConfig = { projects: [project({ packs: ['a', 'b', 'c', 'd'] })] };
  const h = harness(config);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'e', deliver: true });

  assert.deepEqual(config.projects[0].packs, ['a', 'b', 'c', 'd'], 'nothing was ticked away to make room');
  assert.equal(h.reloads.length, 0);
  assert.match(String(resultOf(h)?.error), /at most 4 packs/);
});

test('with no spec listing available a delivery is refused, never guessed at', async () => {
  const config: GlissaConfig = { projects: [project()] };
  const h = harness(config, { omitListPackNames: true });

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: true });

  assert.equal(h.saveCalls.length, 0);
  assert.match(String(resultOf(h)?.error), /not running/);
});

test('a failed config write is reported and never reloaded', async () => {
  const config: GlissaConfig = { projects: [project()] };
  const h = harness(config, { saveFails: true });

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: true });

  assert.deepEqual(h.reloads, []);
  assert.equal(resultOf(h)?.ok, false);
});

test('the requester is answered before the reload, so a throwing reload cannot strand it', async () => {
  const config: GlissaConfig = { projects: [project()] };
  const h = harness(config, { onReload: () => { throw new Error('reload exploded'); } });

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'crew-rules', deliver: true });

  const result = resultOf(h);
  assert.equal(result?.ok, true, 'the persisted change was reported before the reload ran');
  assert.ok(h.broadcasts.some((m) => m.type === 'project-packs-updated'));
});

test("assigning a pack built out of the project's own files is refused by name", async () => {
  const config: GlissaConfig = { projects: [project()] };
  const h = harness(config, { packSourceRoots: { 'house-rules': ['C:/repo/docs'] } });

  await h.send({ type: 'set-project-packs', requestId: 'r1', projectId: 'p1', pack: 'house-rules', deliver: true });

  const result = resultOf(h);
  assert.equal(result?.ok, false);
  assert.match(String(result?.error), /built from files inside this project/);
  assert.equal(config.projects[0].packs, undefined, 'a refusal writes nothing');
  assert.equal(h.saveCalls.length, 0);
  assert.equal(h.reloads.length, 0);
});

test('the same pack is accepted by a project it was not built out of, and removal never checks', async () => {
  const config: GlissaConfig = { projects: [project({ path: 'C:/other', packs: ['house-rules'] })] };
  const h = harness(config, { packSourceRoots: { 'house-rules': ['C:/repo/docs'] } });

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'house-rules', deliver: true });
  assert.deepEqual(config.projects[0].packs, ['house-rules']);

  const removing = harness({ projects: [project({ packs: ['house-rules'] })] }, { packSourceRoots: { 'house-rules': ['C:/repo/docs'] } });
  await removing.send({ type: 'set-project-packs', projectId: 'p1', pack: 'house-rules', deliver: false });
  assert.equal(resultOf(removing)?.ok, true, 'a self-referential pack an operator already has must stay removable');
});
