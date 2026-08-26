// Turning Visions on wires every editor found on the machine, because an advisor that needs a manual
// paste per editor is one nobody has running. Files glissa owns are written whole; a file the operator
// maintains is touched only through the marked block or the single key naming our server, and it is
// backed up once before the first edit.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execSync } = require('./child-process-safe');
const {
  emacsMerge, emacsRemove, helixMerge, helixRemove, jsonSettingsMerge, jsonSettingsRemove, kateSettings,
  neovimDropIn, sublimeSettings,
} = require('./core/editor-wire-core');
const { resolvePathCommandMatches } = require('../session/core/spawn-command');

function configHome(homeDir, env) {
  if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME;
  return path.join(homeDir, '.config');
}

function sublimeUserDir(homeDir, platform, env) {
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', 'Sublime Text', 'Packages', 'User');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Sublime Text', 'Packages', 'User');
  return path.join(configHome(homeDir, env), 'sublime-text', 'Packages', 'User');
}

function neovimConfigDir(homeDir, platform, env) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'nvim');
  return path.join(configHome(homeDir, env), 'nvim');
}

function helixConfigDir(homeDir, platform, env) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'helix');
  return path.join(configHome(homeDir, env), 'helix');
}

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function onPath(command, { platform, exec }) {
  return resolvePathCommandMatches(command, { platform, exec }).length > 0;
}

// An editor's own settings file is safe to CREATE; a startup script like init.el is not, so Emacs is
// wired only into an init file that already exists.
function editorTargets({ homeDir = os.homedir(), platform = process.platform, env = process.env, exec = execSync } = {}) {
  const nvimDir = neovimConfigDir(homeDir, platform, env);
  const helixDir = helixConfigDir(homeDir, platform, env);
  const kateDir = path.join(configHome(homeDir, env), 'kate', 'lspclient');
  const sublimeDir = sublimeUserDir(homeDir, platform, env);
  const emacsInits = [path.join(homeDir, '.emacs.d', 'init.el'), path.join(configHome(homeDir, env), 'emacs', 'init.el')];

  const targets = [];
  if (exists(nvimDir) || onPath('nvim', { platform, exec })) {
    targets.push({
      id: 'neovim', label: 'Neovim', filePath: path.join(nvimDir, 'plugin', 'glissa-visions.lua'), owned: true, create: true,
    });
  }
  if (exists(helixDir) || onPath('hx', { platform, exec })) {
    targets.push({
      id: 'helix', label: 'Helix', filePath: path.join(helixDir, 'languages.toml'), merge: helixMerge, unmerge: helixRemove, create: true,
    });
  }
  if (exists(kateDir) || onPath('kate', { platform, exec })) {
    targets.push({
      id: 'kate', label: 'Kate', filePath: path.join(kateDir, 'settings.json'), json: kateSettings, create: true,
    });
  }
  if (exists(sublimeDir)) {
    targets.push({
      id: 'sublime', label: 'Sublime Text', filePath: path.join(sublimeDir, 'LSP.sublime-settings'), json: sublimeSettings, create: true,
    });
  }
  const emacsInit = emacsInits.find((candidate) => exists(candidate));
  if (emacsInit) targets.push({ id: 'emacs', label: 'Emacs', filePath: emacsInit, merge: emacsMerge, unmerge: emacsRemove, create: false });
  return targets;
}

function readIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// One backup per file, taken before glissa's first edit to it and never overwritten afterwards: the
// point is the state the operator had before any of this ran.
function backupOnce(filePath, existingText) {
  const backupPath = `${filePath}.glissa.bak`;
  if (existingText === null || exists(backupPath)) return null;
  fs.writeFileSync(backupPath, existingText);
  return backupPath;
}

function planFor(target, existingText, invocation) {
  if (target.owned) {
    const text = neovimDropIn(invocation);
    if (existingText === text) return { text, changed: false, reason: 'unchanged' };
    return { text, changed: true, reason: existingText === null ? 'created' : 'updated' };
  }
  if (target.merge) return target.merge(existingText, invocation);
  return jsonSettingsMerge(existingText, target.json(invocation));
}

function unwirePlanFor(target, existingText) {
  // Glissa owns the whole file, so unwiring it is a delete rather than an edit.
  if (target.owned) return { text: null, changed: existingText !== null, reason: existingText === null ? 'unchanged' : 'deleted' };
  if (target.unmerge) return target.unmerge(existingText);
  return jsonSettingsRemove(existingText, target.json({ command: '', args: [] }));
}

function applyPlan(target, existingText, plan, { dryRun }) {
  if (!plan.changed) return { ...outcome(target), action: plan.reason === 'unchanged' ? 'unchanged' : 'skipped', reason: plan.reason };
  if (dryRun) return { ...outcome(target), action: 'would-write', reason: plan.reason };

  try {
    if (plan.text === null) {
      fs.rmSync(target.filePath, { force: true });
      return { ...outcome(target), action: 'removed', reason: plan.reason };
    }
    fs.mkdirSync(path.dirname(target.filePath), { recursive: true });
    backupOnce(target.filePath, existingText);
    fs.writeFileSync(target.filePath, plan.text);
  } catch (error) {
    return { ...outcome(target), action: 'failed', reason: error.message };
  }
  return { ...outcome(target), action: plan.text === null ? 'removed' : 'wrote', reason: plan.reason };
}

function unwireEditor(target, { dryRun = false } = {}) {
  const existingText = readIfPresent(target.filePath);
  if (existingText === null && !target.owned) return { ...outcome(target), action: 'skipped', reason: 'file-absent' };
  return applyPlan(target, existingText, unwirePlanFor(target, existingText), { dryRun });
}

function wireEditor(target, invocation, { dryRun = false } = {}) {
  const existingText = readIfPresent(target.filePath);
  if (existingText === null && !target.create) return { ...outcome(target), action: 'skipped', reason: 'file-absent' };

  const plan = planFor(target, existingText, invocation);
  return applyPlan(target, existingText, plan, { dryRun });
}

function outcome(target) {
  return { id: target.id, label: target.label, filePath: target.filePath };
}

/** @param {{ invocation?: string | { command: string, args: string[] }, dryRun?: boolean, targets?: ReturnType<typeof editorTargets> | null } & Record<string, unknown>} [options] */
function wireEditors({ invocation, dryRun = false, targets = null, ...detection } = {}) {
  const list = targets || editorTargets(detection);
  return list.map((target) => wireEditor(target, invocation, { dryRun }));
}

function unwireEditors({ dryRun = false, targets = null, ...detection } = {}) {
  const list = targets || editorTargets(detection);
  return list.map((target) => unwireEditor(target, { dryRun }));
}

module.exports = {
  editorTargets, unwireEditor, unwireEditors, wireEditor, wireEditors,
};
