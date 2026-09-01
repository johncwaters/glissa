import test from 'node:test';
import assert from 'node:assert/strict';

import { createRtkInstallWiring } from '../server/rtk-install-wiring.ts';
import type { RtkInstallStatus, RtkInstallWiring, RtkInstallWiringOptions } from '../server/rtk-install-wiring.ts';
import { INSTALL_FAILURE_COOLDOWN_MS } from '../server/core/rtk-install-core.ts';

const SILENT = { log() {}, warn() {} };

function deferred(): { parked: Promise<void>; release: () => void } {
  let settle: () => void = () => {};
  const parked = new Promise<void>((resolve) => { settle = resolve; });
  return { parked, release: () => settle() };
}

type WiringFixture = Pick<RtkInstallWiringOptions, 'config' | 'resolveRtk' | 'install' | 'now'>;

function makeWiring({ config, resolveRtk, install, now = () => 0 }: WiringFixture): {
  wiring: RtkInstallWiring;
  statuses: RtkInstallStatus[];
} {
  const statuses: RtkInstallStatus[] = [];
  const wiring = createRtkInstallWiring({
    config,
    homeDir: '/home/test',
    platform: 'linux',
    arch: 'x64',
    log: SILENT,
    now,
    resolveRtk,
    install,
    onStatusChange: (status) => statuses.push(status),
  });
  return { wiring, statuses };
}

test('a settings save with rtk on and no binary triggers exactly one install', async () => {
  let installs = 0;
  let resolved: string | null = null;
  const { wiring, statuses } = makeWiring({
    config: { rtk: true },
    resolveRtk: () => resolved,
    install: async () => {
      installs += 1;
      resolved = '/home/test/.glissa/bin/rtk';
      return { ok: true, path: resolved, version: '0.45.0' };
    },
  });

  await wiring.maybeInstall();
  await wiring.maybeInstall();

  assert.equal(installs, 1);
  assert.deepEqual(statuses.map((status) => status.status), ['installing', 'installed']);
  assert.deepEqual(wiring.getStatus(), { status: 'installed', path: '/home/test/.glissa/bin/rtk' });
});

test('an already resolved binary triggers no install', async () => {
  let installs = 0;
  const { wiring, statuses } = makeWiring({
    config: { rtk: true },
    resolveRtk: () => '/usr/bin/rtk',
    install: async () => {
      installs += 1;
      return { ok: true, path: '/usr/bin/rtk', version: '0.45.0' };
    },
  });

  const decision = await wiring.maybeInstall();

  assert.equal(installs, 0);
  assert.equal(decision.reason, 'already-resolved');
  assert.deepEqual(statuses, []);
  assert.deepEqual(wiring.getStatus(), { status: 'idle' });
});

test('rtk off never installs', async () => {
  let installs = 0;
  const { wiring } = makeWiring({
    config: { rtk: false },
    resolveRtk: () => null,
    install: async () => {
      installs += 1;
      return { ok: false, reason: 'never reached' };
    },
  });

  assert.equal((await wiring.maybeInstall()).reason, 'rtk-disabled');
  assert.equal(installs, 0);
});

test('a failure is reported and held off by the cooldown, then retried once it elapses', async () => {
  let installs = 0;
  let nowMs = 5_000_000;
  const { wiring, statuses } = makeWiring({
    config: { rtk: true },
    resolveRtk: () => null,
    now: () => nowMs,
    install: async () => {
      installs += 1;
      return { ok: false, reason: 'sha256 mismatch' };
    },
  });

  await wiring.maybeInstall();
  assert.deepEqual(wiring.getStatus(), { status: 'failed', reason: 'sha256 mismatch' });

  nowMs += INSTALL_FAILURE_COOLDOWN_MS - 1;
  assert.equal((await wiring.maybeInstall()).reason, 'failure-cooldown');
  assert.equal(installs, 1);

  nowMs += 1;
  await wiring.maybeInstall();
  assert.equal(installs, 2);
  assert.deepEqual(statuses.map((status) => status.status), ['installing', 'failed', 'installing', 'failed']);
});

test('two overlapping triggers install once', async () => {
  let installs = 0;
  const { parked, release } = deferred();
  const { wiring } = makeWiring({
    config: { rtk: true },
    resolveRtk: () => null,
    install: async () => {
      installs += 1;
      await parked;
      return { ok: true, path: '/home/test/.glissa/bin/rtk', version: '0.45.0' };
    },
  });

  const first = wiring.maybeInstall();
  const second = await wiring.maybeInstall();
  assert.equal(second.reason, 'install-in-flight');
  release();
  await first;
  assert.equal(installs, 1);
});
