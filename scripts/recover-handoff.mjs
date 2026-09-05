import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PREVIOUS_DIST_BACKUP_NAME = 'prev-dist';
const PREVIOUS_DEPENDENCIES_BACKUP_NAME = 'prev-node_modules';
const QUARANTINE_NAME_PREFIX = 'broken-';

function isRestoreEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.from !== 'string') return false;
  if (entry.to !== 'dist' && entry.to !== 'node_modules') return false;
  if (!entry.from || path.dirname(entry.from) !== '.') return false;
  return entry.from !== '.' && entry.from !== '..';
}

function restore(updatePath, root, fromName, toName) {
  const sourcePath = path.join(updatePath, fromName);
  const targetPath = path.join(root, toName);
  if (fs.existsSync(targetPath) || !fs.existsSync(sourcePath)) return;
  fs.renameSync(sourcePath, targetPath);
  console.log(`restored ${fromName} to ${toName}`);
}

function restoreOverBrokenTarget(updatePath, root, fromName, toName) {
  const sourcePath = path.join(updatePath, fromName);
  const targetPath = path.join(root, toName);
  if (!fs.existsSync(sourcePath)) return fs.existsSync(targetPath);
  if (fs.existsSync(targetPath)) {
    const quarantinePath = path.join(updatePath, `${QUARANTINE_NAME_PREFIX}${toName}`);
    fs.rmSync(quarantinePath, { recursive: true, force: true });
    fs.renameSync(targetPath, quarantinePath);
    console.log(`quarantined ${toName} as ${QUARANTINE_NAME_PREFIX}${toName}`);
  }
  fs.renameSync(sourcePath, targetPath);
  console.log(`restored ${fromName} to ${toName}`);
  return true;
}

function restoreEverythingHandedOff(root) {
  const updatePath = path.join(root, '.glissa', 'update');
  restore(updatePath, root, PREVIOUS_DEPENDENCIES_BACKUP_NAME, 'node_modules');
  restore(updatePath, root, PREVIOUS_DIST_BACKUP_NAME, 'dist');

  const markerPath = path.join(updatePath, 'restore.json');
  if (!fs.existsSync(markerPath)) return;
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const entries = Array.isArray(marker?.restore) ? marker.restore : [];
  let everyEntryApplied = true;
  for (const entry of entries) {
    if (!isRestoreEntry(entry)) continue;
    if (restoreOverBrokenTarget(updatePath, root, entry.from, entry.to)) continue;
    everyEntryApplied = false;
    console.log(`could not restore ${entry.from} to ${entry.to}`);
  }
  if (!everyEntryApplied) return;
  fs.rmSync(markerPath, { force: true });
  console.log('removed restore marker');
}

function recoverHandoff(root) {
  try {
    restoreEverythingHandedOff(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`handoff recovery could not finish: ${message}`);
  }
}

function wasRunAsTheRecoveryScript() {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  if (path.basename(entryPath) !== 'recover-handoff.mjs') return false;
  return pathToFileURL(entryPath).href === import.meta.url;
}

if (wasRunAsTheRecoveryScript()) {
  recoverHandoff(path.resolve(process.argv[2] || path.join(import.meta.dirname, '..')));
  process.exitCode = 0;
}

export { PREVIOUS_DEPENDENCIES_BACKUP_NAME, PREVIOUS_DIST_BACKUP_NAME, recoverHandoff };
