// Turning Visions on wires every editor found on the machine, because an advisor that needs a manual
// paste per editor is one nobody has running. Files glissa owns are written whole; a file the operator
// maintains is touched only through the marked block or the single key naming our server, and it is
// backed up once before the first edit.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execSync } from './child-process-safe.ts';
import {
  emacsMerge, emacsRemove, helixMerge, helixRemove, jsonSettingsMerge, jsonSettingsRemove, kateSettings,
  neovimDropIn, sublimeSettings,
} from './core/editor-wire-core.ts';
import type { JsonSettingsTarget, WireInvocation } from './core/editor-wire-core.ts';
import { resolvePathCommandMatches } from '../session/core/spawn-command.ts';
import type { PathLookupExec } from '../session/core/spawn-command.ts';

type CommandExec = PathLookupExec;

interface EditorDetection {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: CommandExec;
}

interface EditorTargetBase {
  id: string;
  label: string;
  filePath: string;
  create: boolean;
}

type EditorTarget = EditorTargetBase & (
  | { owned: true; merge?: undefined; unmerge?: undefined; json?: undefined }
  | { owned?: false; merge: typeof helixMerge; unmerge: typeof helixRemove; json?: undefined }
  | { owned?: false; merge?: undefined; unmerge?: undefined; json: (invocation: WireInvocation) => JsonSettingsTarget }
);

interface EditorPlan {
  text: string | null;
  changed: boolean;
  reason: string;
}

interface EditorOutcome {
  id: string;
  label: string;
  filePath: string;
  action: string;
  reason: string;
}

function configHome(homeDir: string, env: NodeJS.ProcessEnv): string {
  if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME;
  return path.join(homeDir, '.config');
}

function sublimeUserDir(homeDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', 'Sublime Text', 'Packages', 'User');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Sublime Text', 'Packages', 'User');
  return path.join(configHome(homeDir, env), 'sublime-text', 'Packages', 'User');
}

function neovimConfigDir(homeDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'nvim');
  return path.join(configHome(homeDir, env), 'nvim');
}

function helixConfigDir(homeDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'helix');
  return path.join(configHome(homeDir, env), 'helix');
}

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function onPath(command: string, { platform, exec }: { platform: NodeJS.Platform; exec: CommandExec }): boolean {
  return resolvePathCommandMatches(command, { platform, exec }).length > 0;
}

// An editor's own settings file is safe to CREATE; a startup script like init.el is not, so Emacs is
// wired only into an init file that already exists.
function editorTargets({ homeDir = os.homedir(), platform = process.platform, env = process.env, exec = execSync }: EditorDetection = {}): EditorTarget[] {
  const nvimDir = neovimConfigDir(homeDir, platform, env);
  const helixDir = helixConfigDir(homeDir, platform, env);
  const kateDir = path.join(configHome(homeDir, env), 'kate', 'lspclient');
  const sublimeDir = sublimeUserDir(homeDir, platform, env);
  const emacsInits = [path.join(homeDir, '.emacs.d', 'init.el'), path.join(configHome(homeDir, env), 'emacs', 'init.el')];

  const targets: EditorTarget[] = [];
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

function readIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// One backup per file, taken before glissa's first edit to it and never overwritten afterwards: the
// point is the state the operator had before any of this ran.
function backupOnce(filePath: string, existingText: string | null): string | null {
  const backupPath = `${filePath}.glissa.bak`;
  if (existingText === null || exists(backupPath)) return null;
  fs.writeFileSync(backupPath, existingText);
  return backupPath;
}

function planFor(target: EditorTarget, existingText: string | null, invocation: WireInvocation): EditorPlan {
  if (target.owned) {
    const text = neovimDropIn(invocation);
    if (existingText === text) return { text, changed: false, reason: 'unchanged' };
    return { text, changed: true, reason: existingText === null ? 'created' : 'updated' };
  }
  if (target.merge) return target.merge(existingText, invocation);
  return jsonSettingsMerge(existingText ?? '', target.json(invocation));
}

function unwirePlanFor(target: EditorTarget, existingText: string | null): EditorPlan {
  // Glissa owns the whole file, so unwiring it is a delete rather than an edit.
  if (target.owned) return { text: null, changed: existingText !== null, reason: existingText === null ? 'unchanged' : 'deleted' };
  if (target.unmerge) return target.unmerge(existingText);
  return jsonSettingsRemove(existingText ?? '', target.json({ command: '', args: [] }));
}

function applyPlan(target: EditorTarget, existingText: string | null, plan: EditorPlan, { dryRun }: { dryRun: boolean }): EditorOutcome {
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
    return { ...outcome(target), action: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
  return { ...outcome(target), action: plan.text === null ? 'removed' : 'wrote', reason: plan.reason };
}

function unwireEditor(target: EditorTarget, { dryRun = false }: { dryRun?: boolean } = {}): EditorOutcome {
  const existingText = readIfPresent(target.filePath);
  if (existingText === null && !target.owned) return { ...outcome(target), action: 'skipped', reason: 'file-absent' };
  return applyPlan(target, existingText, unwirePlanFor(target, existingText), { dryRun });
}

function wireEditor(target: EditorTarget, invocation: WireInvocation, { dryRun = false }: { dryRun?: boolean } = {}): EditorOutcome {
  const existingText = readIfPresent(target.filePath);
  if (existingText === null && !target.create) return { ...outcome(target), action: 'skipped', reason: 'file-absent' };

  const plan = planFor(target, existingText, invocation);
  return applyPlan(target, existingText, plan, { dryRun });
}

function outcome(target: EditorTarget): { id: string; label: string; filePath: string } {
  return { id: target.id, label: target.label, filePath: target.filePath };
}

interface WireEditorsOptions extends EditorDetection {
  invocation: WireInvocation;
  dryRun?: boolean;
  targets?: EditorTarget[] | null;
}

function wireEditors({ invocation, dryRun = false, targets = null, ...detection }: WireEditorsOptions): EditorOutcome[] {
  const list = targets || editorTargets(detection);
  return list.map((target) => wireEditor(target, invocation, { dryRun }));
}

function unwireEditors({ dryRun = false, targets = null, ...detection }: {
  dryRun?: boolean;
  targets?: EditorTarget[] | null;
} & EditorDetection = {}): EditorOutcome[] {
  const list = targets || editorTargets(detection);
  return list.map((target) => unwireEditor(target, { dryRun }));
}

export {
  editorTargets, unwireEditor, unwireEditors, wireEditor, wireEditors,
};
export type { EditorDetection, EditorOutcome, EditorPlan, EditorTarget, WireEditorsOptions };
