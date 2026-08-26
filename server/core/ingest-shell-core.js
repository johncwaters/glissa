/*
 * Pure core of the shell-history ingest source (docs/plan-ingestion.md, M10): where each shell writes
 * its history, how one physical line of each format becomes a command, and which commands are worth
 * publishing at all. No IO, no timers, no clock: the shell passes `now` in and gets locations, commands
 * or an event back.
 *
 * Machine scope is the whole contract here. A history file records the command text and nothing else,
 * so no event this file builds can ever carry a project root, and the digest labels a null root as
 * machine scope rather than letting a reader assume this project ran it (redline finding).
 *
 * The noise rules are dispatch-budget load-bearing, not cosmetics. Since M7.5 every published event
 * advances the Visions lane's movement signal, so a shell that writes a line per Enter press (PSReadLine
 * does, repeats included) would spend real dispatch budget on a carbon unit pressing up-arrow.
 */

'use strict';

const path = require('node:path');

const { stringOrNull } = require('./usage-number-core');

const SOURCE = 'shellHistory';
const SHELLS = Object.freeze(['powershell', 'fish', 'bash', 'zsh']);
/*
 * The two shells that append to their history file on every accepted command with no setup at all:
 * PSReadLine defaults to SaveIncrementally, and fish writes incrementally with timestamps. bash and zsh
 * write only at shell EXIT by default, so tailing them would report a whole session at once, hours late;
 * they are opt-in behind the rc snippet this plan documents, never a default (docs/plan-ingestion.md,
 * "Shell history").
 */
const DEFAULT_SHELLS = Object.freeze(['powershell', 'fish']);

// PSReadLine names its file after the HOST, so one directory holds ConsoleHost_history.txt beside a
// "Visual Studio Code Host_history.txt". Every one of them is a real shell the operator typed into.
const PSREADLINE_SUFFIX = '_history.txt';

// A corrupt or half-written file must not build an unbounded string out of continuation markers, so an
// entry that runs past either bound is finished where it stands. This is the ONLY bound on the text a
// command publishes: nothing here slices it, because the scrub has to see the whole value first.
const MAX_COMMAND_CHARS = 4000;
const MAX_CONTINUATION_LINES = 64;

/*
 * Navigation and screen clearing, exact and lowercased. A bare `ls` says the carbon unit looked around;
 * `ls -R src` is a real action, so only the bare forms drop. Lowercasing can only ever ADD a match
 * against this fixed set, and PowerShell is case insensitive, so `CLS` is the same command as `cls`.
 */
const TRIVIAL_COMMANDS = new Set([
  '', 'l', 'ls', 'll', 'la', 'dir', 'cd', 'cd ..', 'cd -', 'cd ~', 'cd /', 'pwd', 'cls', 'clear',
  'exit', 'q', 'history',
]);

// --- Config ---------------------------------------------------------------

/**
 * `sources.shellHistory.shells` -> the shells to tail, plus the entries that named nothing so the IO
 * shell can say so once. Absent or empty means the zero-setup pair; an explicit list names EXACTLY the
 * shells to tail, which is how an operator who added the rc snippet opts bash or zsh in, and equally how
 * one who lives in fish opts PowerShell out.
 *
 * A NON-EMPTY list naming no known shell resolves to NOTHING, never to the defaults. This is the one
 * source that must be asked for explicitly, so a typo has to cost the operator their configuration
 * rather than silently widening what glissa reads to shells they did not name.
 */
function normalizeShells(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { shells: [...DEFAULT_SHELLS], rejected: [] };
  const shells = [];
  const rejected = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    // pwsh and Windows PowerShell share one PSReadLine directory, so they are one shell here.
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

// --- Discovery ------------------------------------------------------------

function resolveHomeDir(env, homeDir) {
  return stringOrNull(env?.HOME) || stringOrNull(env?.USERPROFILE) || homeDir;
}

function dataHome(env, homeDir) {
  return stringOrNull(env?.XDG_DATA_HOME) || path.join(resolveHomeDir(env, homeDir), '.local', 'share');
}

function configHome(env, homeDir) {
  return stringOrNull(env?.XDG_CONFIG_HOME) || path.join(resolveHomeDir(env, homeDir), '.config');
}

/*
 * Windows PowerShell 5.1 and pwsh 7 share this path exactly, which is why the location list is deduped
 * rather than one entry per host executable: tailing it twice would publish every command twice.
 */
function powershellLocations(env, platform, homeDir) {
  if (platform === 'win32') {
    const appData = stringOrNull(env?.APPDATA) || path.join(resolveHomeDir(env, homeDir), 'AppData', 'Roaming');
    const dir = path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine');
    return [{ shell: 'powershell', dir, suffix: PSREADLINE_SUFFIX, name: null }];
  }
  // PSReadLine on non-Windows resolves LocalApplicationData, which .NET maps to XDG_DATA_HOME.
  const dir = path.join(dataHome(env, homeDir), 'powershell', 'PSReadLine');
  return [{ shell: 'powershell', dir, suffix: PSREADLINE_SUFFIX, name: null }];
}

function fishLocations(env, homeDir) {
  return [
    { shell: 'fish', dir: path.join(dataHome(env, homeDir), 'fish'), suffix: null, name: 'fish_history' },
    // fish before 3.0 kept history beside the config, and a machine upgraded in place still has it.
    { shell: 'fish', dir: path.join(configHome(env, homeDir), 'fish'), suffix: null, name: 'fish_history' },
  ];
}

function fileLocation(shell, filePath) {
  return { shell, dir: path.dirname(filePath), suffix: null, name: path.basename(filePath) };
}

/*
 * HISTFILE names ONE file, so it is only unambiguous when exactly one of bash and zsh is configured.
 * With both on it is skipped and the documented rc snippet's default paths stand, which is why that
 * snippet pins HISTFILE explicitly rather than relying on the shell's own default.
 */
function histFileLocation(wanted, env) {
  const posixShells = wanted.filter((shell) => shell === 'bash' || shell === 'zsh');
  if (posixShells.length !== 1) return [];
  const histFile = stringOrNull(env?.HISTFILE);
  if (!histFile) return [];
  return [fileLocation(posixShells[0], histFile)];
}

function defaultHistFiles(shell, env, homeDir) {
  const home = resolveHomeDir(env, homeDir);
  if (shell === 'bash') return [fileLocation('bash', path.join(home, '.bash_history'))];
  // zsh has no default HISTFILE at all; these are the two names every distributed zshrc actually sets.
  return [
    fileLocation('zsh', path.join(home, '.zsh_history')),
    fileLocation('zsh', path.join(home, '.histfile')),
  ];
}

function locationKey(location) {
  return `${path.resolve(location.dir)}|${location.name || location.suffix}`;
}

/**
 * Where each configured shell writes its history, in preference order. DIRECTORIES, not files: the
 * shared tail mechanics watch the parent so a rename or a rewrite cannot strand the watch, and a
 * `suffix` location tails every matching name in its directory.
 *
 * Nothing here touches the filesystem. A location whose directory does not exist is simply never
 * tracked, which is the vendor-home rule the usage lane already follows: an absent shell is absent,
 * never an error.
 */
function historyLocations({ shells = null, env = {}, platform = process.platform, homeDir = null } = {}) {
  const wanted = normalizeShells(shells).shells;
  const locations = [...histFileLocation(wanted, env)];
  for (const shell of wanted) {
    if (shell === 'powershell') locations.push(...powershellLocations(env, platform, homeDir));
    if (shell === 'fish') locations.push(...fishLocations(env, homeDir));
    if (shell === 'bash' || shell === 'zsh') locations.push(...defaultHistFiles(shell, env, homeDir));
  }
  const seen = new Set();
  const deduped = [];
  for (const location of locations) {
    const key = locationKey(location);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(location);
  }
  return deduped;
}

/**
 * Whether one directory entry belongs to a location. Suffix matching folds case, because the PSReadLine
 * directory is a Windows path where `ConsoleHost_history.txt` and its lowercase spelling are one file;
 * an exact `name` is compared as written, since fish lives on case-sensitive filesystems.
 */
function matchesLocation(location, filename) {
  if (typeof filename !== 'string' || !filename) return false;
  if (location?.name) return filename === location.name;
  const suffix = location?.suffix;
  if (!suffix) return false;
  if (filename.length <= suffix.length) return false;
  return filename.toLowerCase().endsWith(suffix.toLowerCase());
}

// --- Parsing --------------------------------------------------------------

function createParseState() {
  return { pending: [], pendingTs: null, entry: null };
}

function withinContinuationBounds(pending) {
  if (pending.length >= MAX_CONTINUATION_LINES) return false;
  let chars = 0;
  for (const line of pending) chars += line.length + 1;
  return chars < MAX_COMMAND_CHARS;
}

/*
 * PSReadLine writes an embedded newline as a trailing backtick, so a multi-line command is N physical
 * lines with a marker on all but the last. That means a command ENDING in a newline finishes on an
 * empty physical line, which is why the tail read keeps empty lines for this source: dropping one would
 * glue that command to the next.
 */
function parsePowershell(lines, state) {
  const commands = [];
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

// fish escapes a backslash as two and an embedded newline as backslash-n, so one left-to-right pass
// undoes both without a second pass re-reading what the first produced.
function unescapeFish(text) {
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

/*
 * fish writes a whole entry at once (`- cmd:` then an indented `when:`, then an optional `paths:` list),
 * so the command is held until its timestamp line arrives rather than published with an arrival time it
 * did not need. A read landing between the two costs that command one poll interval, never the command;
 * an entry whose `when` never arrives at all is finished by the next entry starting.
 */
function parseFish(lines, state) {
  const commands = [];
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

// Nine digits or more, so an ordinary `#5` comment in a history file is not read as an epoch.
const BASH_TIMESTAMP = /^#(\d{9,})\s*$/;

function parseBash(lines, state) {
  const commands = [];
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

/*
 * EXTENDED_HISTORY heads each entry with `: <epoch>:<elapsed>;`, and zsh escapes an embedded newline
 * with a trailing backslash. The prefix is read only at the START of an entry, since a continuation
 * line carries raw command text that could otherwise be mistaken for one.
 */
function parseZsh(lines, state) {
  const commands = [];
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

const PARSERS = Object.freeze({
  powershell: parsePowershell, fish: parseFish, bash: parseBash, zsh: parseZsh,
});

/**
 * One read's worth of complete lines in, the commands they FINISHED plus the parser state the next read
 * continues from. Nothing is mutated: the state goes in and a fresh one comes back, so the IO shell owns
 * every piece of mutable state and this file owns none.
 */
/** @param {any} options */
function parseHistoryLines({ shell, lines = [], state = null } = /** @type {any} */ ({})) {
  const current = state || createParseState();
  const parser = PARSERS[shell];
  if (!parser || !Array.isArray(lines) || lines.length === 0) return { commands: [], state: current };
  return parser(lines, current);
}

// --- Events ---------------------------------------------------------------

/*
 * The COMPARISON key, never the published text. Folding is right for deciding whether two commands are
 * the same one and wrong for what gets published: the scrub's value patterns stop at a line break on
 * purpose, so folding a multi-line command before the scrub ran would let one line's pattern reach into
 * the innocent line under it.
 */
function foldForCompare(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function isTrivialCommand(text) {
  if (typeof text !== 'string') return true;
  return TRIVIAL_COMMANDS.has(text.trim().toLowerCase());
}

/**
 * One parsed command -> the event it publishes, or null, plus the `previous` text the next call compares
 * against. Two noise rules: a trivial command never publishes, and a command identical to the one before
 * it from the same file collapses, because PSReadLine records every Enter press including a repeat.
 *
 * The summary leaves here RAW: unfolded and unsliced. `normalizeEvent` scrubs it, then folds it to one
 * line, then slices it to the ring's bound, and that ORDER is the whole point. Slicing here first would
 * cut the closing quote off a quoted secret, leaving the scrub's quoted alternative unmatched and its
 * bare-token alternative taking only the first word of the value, so the rest of the secret would be
 * published. What keeps the raw text finite is the continuation bound above, not a slice.
 *
 * The scope is machine, always. A history file records no cwd, no exit code and no duration, so nothing
 * here can name a project, and `buildContextDigest` renders a null root as machine scope.
 */
/** @param {any} options */
function decideCommandEvent({ shell, command = null, previous = null, now = 0 } = /** @type {any} */ ({})) {
  const text = typeof command?.text === 'string' ? command.text : '';
  // Compared UNSLICED, so two long commands that first differ past some prefix stay two commands.
  const compared = foldForCompare(text);
  if (!compared) return { event: null, previous };
  if (isTrivialCommand(compared)) return { event: null, previous: compared };
  if (compared === previous) return { event: null, previous: compared };
  const stamped = Number(command.ts);
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

module.exports = {
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
