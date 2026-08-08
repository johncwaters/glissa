'use strict';

// `glissa pair` - mint, list, and revoke remote-mode device pairings.
//
// Lives in server/ rather than bin/ on purpose: package.json "files" whitelists bin entries one by
// one but ships server/ wholesale, so a new bin/ module would be missing from the published tarball
// and scripts/check-package-files.js would fail the publish.
//
// The CLI is the operator-side half of remote mode. It never talks to a running server: it writes the
// same pairings.json the server watches, so a mint or a revoke takes effect without a restart.

const fs = require('node:fs');

const { resolveConfigPath } = require('./config-store');
const { normalizeRemoteConfig } = require('./core/remote-config');
const {
  createPairingsStore, createSeenStore, defaultPairingsPath, defaultSeenPath,
  REVOCATION_PROPAGATION_SECONDS,
} = require('./pairings-store');

const PASSWORD_WARNING = [
  'Treat this link like a password. Anyone who opens it gets full control of this',
  'machine through Glissa (it can start Claude Code sessions in any directory).',
  'It works once and expires in 10 minutes.',
].join('\n');

function readConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${configPath}: ${err.message}`);
    return null;
  }
}

function argValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function formatTimestamp(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function pad(value, width) {
  const str = String(value);
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

function buildPairUrl(remote, token) {
  if (remote.publicHost) return `https://${remote.publicHost}/pair/${token}`;
  const port = remote.port || 3001;
  return `http://127.0.0.1:${port}/pair/${token}`;
}

function runMint(store, remote, name) {
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

function runList(store, seenStore) {
  const devices = store.listDevices();
  if (devices.length === 0) {
    console.log('No paired devices.');
    return 0;
  }
  const seen = seenStore.readAll();
  console.log(`${pad('ID', 14)}${pad('NAME', 22)}${pad('PAIRED', 21)}${pad('LAST SEEN', 21)}STATUS`);
  for (const device of devices) {
    const status = device.revokedAt ? `revoked ${formatTimestamp(device.revokedAt)}` : 'active';
    console.log(
      pad(device.id, 14)
      + pad(device.name || '-', 22)
      + pad(formatTimestamp(device.createdAt), 21)
      + pad(formatTimestamp(seen[device.id]), 21)
      + status
    );
  }
  return 0;
}

function runRevoke(store, id) {
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

/**
 * @param {string[]} args argv after the `pair` subcommand
 * @returns {number} process exit code
 */
function runPairCli(args) {
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

module.exports = { runPairCli, buildPairUrl, PASSWORD_WARNING };
