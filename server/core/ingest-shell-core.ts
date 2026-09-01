
import path from 'node:path';

import { stringOrNull } from './usage-number-core.ts';

const SOURCE = 'shellHistory';
const SHELLS: readonly string[] = Object.freeze(['powershell', 'fish', 'bash', 'zsh']);
const DEFAULT_SHELLS: readonly string[] = Object.freeze(['powershell', 'fish']);

const PSREADLINE_SUFFIX = '_history.txt';

const MAX_COMMAND_CHARS = 4000;
const MAX_CONTINUATION_LINES = 64;

const TRIVIAL_COMMANDS = new Set([
  '', 'l', 'ls', 'll', 'la', 'dir', 'cd', 'cd ..', 'cd -', 'cd ~', 'cd /', 'pwd', 'cls', 'clear',
  'exit', 'q', 'history',
]);

export interface HistoryLocation {
  shell: string;
  dir: string;
  suffix: string | null;
  name: string | null;
}

export interface ParsedCommand {
  text: string;
  ts: number | null;
}

export interface HistoryParseState {
  pending: string[];
  pendingTs: number | null;
  entry: ParsedCommand | null;
}

export interface ParseResult {
  commands: ParsedCommand[];
  state: HistoryParseState;
}

export type ShellIngestEvent = {
  source: string;
  kind: string;
  ts: number;
  scope: { root: string | null; sessionId: string | null };
  summary: string;
  detail: { shell: string; lines?: number; droppedCommands?: number };
}


function normalizeShells(raw: unknown): { shells: string[]; rejected: string[] } {
  if (!Array.isArray(raw) || raw.length === 0) return { shells: [...DEFAULT_SHELLS], rejected: [] };
  const shells: string[] = [];
  const rejected: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    const shell = name === 'pwsh' || name === 'powershell.exe' ? 'powershell' : name;
    if (SHELLS.includes(shell)) {
      if (!shells.includes(shell)) shells.push(shell);
      continue;
    }
    const label = typeof entry === 'string' ? entry.trim() : String(entry);
    if (rejected.includes(label)) continue;
    rejected.push(label);
  }
  return { shells, rejected };
}


function resolveHomeDir(env: NodeJS.ProcessEnv | null | undefined, homeDir: string | null): string {
  return (stringOrNull(env?.HOME) || stringOrNull(env?.USERPROFILE) || homeDir) as string;
}

function dataHome(env: NodeJS.ProcessEnv | null | undefined, homeDir: string | null): string {
  return stringOrNull(env?.XDG_DATA_HOME) || path.join(resolveHomeDir(env, homeDir), '.local', 'share');
}

function configHome(env: NodeJS.ProcessEnv | null | undefined, homeDir: string | null): string {
  return stringOrNull(env?.XDG_CONFIG_HOME) || path.join(resolveHomeDir(env, homeDir), '.config');
}

function powershellLocations(
  env: NodeJS.ProcessEnv | null | undefined,
  platform: NodeJS.Platform,
  homeDir: string | null,
): HistoryLocation[] {
  if (platform === 'win32') {
    const appData = stringOrNull(env?.APPDATA) || path.join(resolveHomeDir(env, homeDir), 'AppData', 'Roaming');
    const dir = path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine');
    return [{ shell: 'powershell', dir, suffix: PSREADLINE_SUFFIX, name: null }];
  }
  const dir = path.join(dataHome(env, homeDir), 'powershell', 'PSReadLine');
  return [{ shell: 'powershell', dir, suffix: PSREADLINE_SUFFIX, name: null }];
}

function fishLocations(env: NodeJS.ProcessEnv | null | undefined, homeDir: string | null): HistoryLocation[] {
  return [
    { shell: 'fish', dir: path.join(dataHome(env, homeDir), 'fish'), suffix: null, name: 'fish_history' },
    { shell: 'fish', dir: path.join(configHome(env, homeDir), 'fish'), suffix: null, name: 'fish_history' },
  ];
}

function fileLocation(shell: string, filePath: string): HistoryLocation {
  return { shell, dir: path.dirname(filePath), suffix: null, name: path.basename(filePath) };
}

function histFileLocation(wanted: string[], env: NodeJS.ProcessEnv | null | undefined): HistoryLocation[] {
  const posixShells = wanted.filter((shell) => shell === 'bash' || shell === 'zsh');
  if (posixShells.length !== 1) return [];
  const histFile = stringOrNull(env?.HISTFILE);
  if (!histFile) return [];
  return [fileLocation(posixShells[0], histFile)];
}

function defaultHistFiles(
  shell: string,
  env: NodeJS.ProcessEnv | null | undefined,
  homeDir: string | null,
): HistoryLocation[] {
  const home = resolveHomeDir(env, homeDir);
  if (shell === 'bash') return [fileLocation('bash', path.join(home, '.bash_history'))];
  return [
    fileLocation('zsh', path.join(home, '.zsh_history')),
    fileLocation('zsh', path.join(home, '.histfile')),
  ];
}

function locationKey(location: HistoryLocation): string {
  return `${path.resolve(location.dir)}|${location.name || location.suffix}`;
}

function historyLocations({
  shells = null,
  env = {},
  platform = process.platform,
  homeDir = null,
}: {
  shells?: string[] | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string | null;
} = {}): HistoryLocation[] {
  const wanted = normalizeShells(shells).shells;
  const locations: HistoryLocation[] = [...histFileLocation(wanted, env)];
  for (const shell of wanted) {
    if (shell === 'powershell') locations.push(...powershellLocations(env, platform, homeDir));
    if (shell === 'fish') locations.push(...fishLocations(env, homeDir));
    if (shell === 'bash' || shell === 'zsh') locations.push(...defaultHistFiles(shell, env, homeDir));
  }
  const seen = new Set<string>();
  const deduped: HistoryLocation[] = [];
  for (const location of locations) {
    const key = locationKey(location);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(location);
  }
  return deduped;
}

function matchesLocation(location: Partial<HistoryLocation> | null | undefined, filename: unknown): boolean {
  if (typeof filename !== 'string' || !filename) return false;
  if (location?.name) return filename === location.name;
  const suffix = location?.suffix;
  if (!suffix) return false;
  if (filename.length <= suffix.length) return false;
  return filename.toLowerCase().endsWith(suffix.toLowerCase());
}


function createParseState(): HistoryParseState {
  return { pending: [], pendingTs: null, entry: null };
}

function withinContinuationBounds(pending: string[]): boolean {
  if (pending.length >= MAX_CONTINUATION_LINES) return false;
  let chars = 0;
  for (const line of pending) chars += line.length + 1;
  return chars < MAX_COMMAND_CHARS;
}

function parsePowershell(lines: string[], state: HistoryParseState): ParseResult {
  const commands: ParsedCommand[] = [];
  let pending = state.pending;
  for (const line of lines) {
    const continued = line.endsWith('`');
    pending = [...pending, continued ? line.slice(0, -1) : line];
    if (continued && withinContinuationBounds(pending)) continue;
    commands.push({ text: pending.join('\n'), ts: null });
    pending = [];
  }
  return { commands, state: { ...state, pending } };
}

const FISH_ENTRY = /^- cmd:\s?([\s\S]*)$/;
const FISH_WHEN = /^\s+when:\s*(\d+)/;

function unescapeFish(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = text[index + 1];
    if (next === 'n') {
      out += '\n';
      index += 1;
      continue;
    }
    if (next === '\\') {
      out += '\\';
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function parseFish(lines: string[], state: HistoryParseState): ParseResult {
  const commands: ParsedCommand[] = [];
  let entry = state.entry;
  for (const line of lines) {
    const started = FISH_ENTRY.exec(line);
    if (started) {
      if (entry) commands.push(entry);
      entry = { text: unescapeFish(started[1]), ts: null };
      continue;
    }
    if (!entry) continue;
    const when = FISH_WHEN.exec(line);
    if (!when) continue;
    commands.push({ text: entry.text, ts: Number(when[1]) * 1000 });
    entry = null;
  }
  return { commands, state: { ...state, entry } };
}

const BASH_TIMESTAMP = /^#(\d{9,})\s*$/;

function parseBash(lines: string[], state: HistoryParseState): ParseResult {
  const commands: ParsedCommand[] = [];
  let pendingTs = state.pendingTs;
  for (const line of lines) {
    const stamped = BASH_TIMESTAMP.exec(line);
    if (stamped) {
      pendingTs = Number(stamped[1]) * 1000;
      continue;
    }
    if (!line.trim()) continue;
    commands.push({ text: line, ts: pendingTs });
    pendingTs = null;
  }
  return { commands, state: { ...state, pendingTs } };
}

const ZSH_EXTENDED = /^:\s(\d+):(\d+);([\s\S]*)$/;

function parseZsh(lines: string[], state: HistoryParseState): ParseResult {
  const commands: ParsedCommand[] = [];
  let pending = state.pending;
  let pendingTs = state.pendingTs;
  for (const line of lines) {
    const starting = pending.length === 0;
    const extended = starting ? ZSH_EXTENDED.exec(line) : null;
    if (starting) pendingTs = extended ? Number(extended[1]) * 1000 : null;
    const text = extended ? extended[3] : line;
    const continued = text.endsWith('\\');
    pending = [...pending, continued ? text.slice(0, -1) : text];
    if (continued && withinContinuationBounds(pending)) continue;
    const joined = pending.join('\n');
    pending = [];
    if (joined.trim()) commands.push({ text: joined, ts: pendingTs });
    pendingTs = null;
  }
  return { commands, state: { ...state, pending, pendingTs } };
}

const PARSERS: Readonly<Record<string, ((lines: string[], state: HistoryParseState) => ParseResult) | undefined>> = Object.freeze({
  powershell: parsePowershell, fish: parseFish, bash: parseBash, zsh: parseZsh,
});

function parseHistoryLines({
  shell,
  lines = [],
  state = null,
}: { shell?: string; lines?: string[]; state?: HistoryParseState | null } = {}): ParseResult {
  const current = state || createParseState();
  const parser = shell ? PARSERS[shell] : undefined;
  if (!parser || !Array.isArray(lines) || lines.length === 0) return { commands: [], state: current };
  return parser(lines, current);
}


function foldForCompare(text: unknown): string {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function isTrivialCommand(text: unknown): boolean {
  if (typeof text !== 'string') return true;
  return TRIVIAL_COMMANDS.has(text.trim().toLowerCase());
}

function decideCommandEvent({
  shell = '',
  command = null,
  previous = null,
  now = 0,
}: {
  shell?: string;
  command?: Partial<ParsedCommand> | null;
  previous?: string | null;
  now?: number;
} = {}): { event: ShellIngestEvent | null; previous: string | null } {
  const text = typeof command?.text === 'string' ? command.text : '';
  const compared = foldForCompare(text);
  if (!compared) return { event: null, previous };
  if (isTrivialCommand(compared)) return { event: null, previous: compared };
  if (compared === previous) return { event: null, previous: compared };
  const stamped = Number(command?.ts);
  const lineCount = text.split('\n').length;
  return {
    event: {
      source: SOURCE,
      kind: 'command',
      ts: Number.isFinite(stamped) && stamped > 0 ? Math.floor(stamped) : now,
      scope: { root: null, sessionId: null },
      summary: `${shell}: ${text}`,
      detail: lineCount > 1 ? { shell, lines: lineCount } : { shell },
    },
    previous: compared,
  };
}

export {
  DEFAULT_SHELLS,
  MAX_COMMAND_CHARS,
  MAX_CONTINUATION_LINES,
  SHELLS,
  createParseState,
  decideCommandEvent,
  historyLocations,
  isTrivialCommand,
  matchesLocation,
  normalizeShells,
  parseHistoryLines,
  unescapeFish,
};
