// `glissa pair` - mint, list, and revoke remote-mode device pairings.
//
// Lives in server/ rather than bin/ on purpose: package.json "files" whitelists bin entries one by
// one but ships server/ wholesale, so a new bin/ module would be missing from the published tarball
// and scripts/check-package-files.js would fail the publish.
//
// The CLI is the operator-side half of remote mode. It never talks to a running server: it writes the
// same pairings.json the server watches, so a mint or a revoke takes effect without a restart.

import fs from 'node:fs';

import { resolveConfigPath } from './config-store.ts';
import { normalizeRemoteConfig } from './core/remote-config.ts';
import {
  REVOCATION_PROPAGATION_SECONDS,
  createPairingsStore, createSeenStore, defaultPairingsPath, defaultSeenPath,
} from './pairings-store.ts';
import type { PairingsStore, SeenStore } from './pairings-store.ts';
import { formatTimestamp } from './text-format.ts';

const PASSWORD_WARNING = [
  'Treat this link like a password. Anyone who opens it gets full control of this',
  'machine through Glissa (it can start Claude Code sessions in any directory).',
  'It works once and expires in 10 minutes.',
].join('\n');

interface RemoteSettings {
  enabled: boolean;
  port: number | null;
  publicHost: string;
}

function readConfig(configPath: string): { remote?: unknown } | null {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function argValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function buildPairUrl(remote: RemoteSettings, token: string): string {
  if (remote.publicHost) return `https://${remote.publicHost}/pair/${token}`;
  return `http://127.0.0.1:${remote.port}/pair/${token}`;
}

function runMint(store: PairingsStore, remote: RemoteSettings, name: string | null): number {
  if (!remote.publicHost && !remote.port) {
    console.error('remote.port is not set, so a pairing link cannot be built.');
    console.error('Set remote.port (and remote.publicHost for a shareable link) in config.json first.');
    return 1;
  }
  const minted = store.mintPending({ name: name || '' });
  if (!minted) {
    console.error('Failed to write the pairing file - no token was created.');
    return 1;
  }
  console.log('');
  console.log(`  ${buildPairUrl(remote, minted.token)}`);
  console.log('');
  console.log(PASSWORD_WARNING);
  if (!remote.publicHost) {
    console.log('');
    console.log('remote.publicHost is not set, so the link above points at loopback.');
    console.log('Set it to the hostname your reverse proxy serves to get a shareable link.');
  }
  if (!remote.enabled) {
    console.log('');
    console.log('Note: remote.enabled is false, so the remote listener is not running yet.');
  }
  return 0;
}

function runList(store: PairingsStore, seenStore: SeenStore): number {
  const devices = store.listDevices();
  if (devices.length === 0) {
    console.log('No paired devices.');
    return 0;
  }
  const seen = seenStore.readAll();
  console.log(`${'ID'.padEnd(14)}${'NAME'.padEnd(22)}${'PAIRED'.padEnd(21)}${'LAST SEEN'.padEnd(21)}STATUS`);
  for (const device of devices) {
    const status = device.revokedAt ? `revoked ${formatTimestamp(device.revokedAt)}` : 'active';
    console.log(
      device.id.padEnd(14)
      + (device.name || '-').padEnd(22)
      + formatTimestamp(device.createdAt).padEnd(21)
      + formatTimestamp(seen[device.id]).padEnd(21)
      + status,
    );
  }
  return 0;
}

function runRevoke(store: PairingsStore, id: string): number {
  const outcome = store.revokeDevice(id);
  if (outcome.ok) {
    // Deliberately quotes the WORST case, not the usual one. A running server normally sees this
    // within a second via fs.watch, but that watcher can fail to install or be dropped silently, and
    // the reload interval is the guarantee. Promising "instant" would be a promise the code cannot keep.
    console.log(`Revoked ${id}. A running Glissa applies this within ${REVOCATION_PROPAGATION_SECONDS} seconds, no restart needed.`);
    return 0;
  }
  if (outcome.reason === 'unknown') {
    console.error(`No paired device with id ${id}. Run "glissa pair --list" to see the ids.`);
    return 1;
  }
  console.error('Failed to write the pairing file - nothing was revoked.');
  return 1;
}

/** `args` is argv after the `pair` subcommand; the return value is the process exit code. */
function runPairCli(args: string[]): number {
  const configPath = resolveConfigPath();
  const config = readConfig(configPath);
  if (!config) return 1;
  const remote = normalizeRemoteConfig(config.remote);
  const store = createPairingsStore({ filePath: defaultPairingsPath(configPath) });
  const seenStore = createSeenStore({ filePath: defaultSeenPath(configPath) });

  if (args.includes('--list')) return runList(store, seenStore);

  if (args.includes('--revoke')) {
    const id = argValue(args, '--revoke');
    if (!id) {
      console.error('Usage: glissa pair --revoke <device-id>');
      return 1;
    }
    return runRevoke(store, id);
  }

  store.prunePending();
  return runMint(store, remote, argValue(args, '--name'));
}

export { PASSWORD_WARNING, buildPairUrl, runPairCli };
