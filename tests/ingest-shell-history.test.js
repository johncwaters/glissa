'use strict';

/*
 * The shell-history ingest source against REAL temp directories (docs/plan-ingestion.md, M10): synthetic
 * PSReadLine and fish history files written to disk and driven end to end into the rings, the EOF start,
 * the rewrite re-baseline, the lazy discovery of a file that did not exist yet, and both degradations.
 *
 * The EOF start is the rule this file exists for. A real ConsoleHost_history.txt holds thousands of
 * commands going back months, so a source that read from byte zero would fill its whole ring with a
 * machine's history on every daemon start, then spend the Visions lane's movement signal announcing it.
 *
 * SAFETY: every path is a throwaway temp directory injected through APPDATA, HOME and XDG_DATA_HOME, and
 * `platform` is passed explicitly, so no test here ever reads the operator's real shell history.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createShellHistoryIngest } = require('../server/ingest-shell-history');
const { createIngestLane } = require('../server/ingest-wiring');
const { resolveIngestConfig } = require('../server/core/ingest-core');

// --- Harness --------------------------------------------------------------

function makeHome() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-shellhist-'));
  const appData = path.join(tmpDir, 'AppData', 'Roaming');
  const psDir = path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine');
  const dataHome = path.join(tmpDir, '.local', 'share');
  const fishDir = path.join(dataHome, 'fish');
  return {
    tmpDir,
    psDir,
    fishDir,
    env: {
      APPDATA: appData,
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: path.join(tmpDir, '.config'),
    },
  };
}

function inertTimers() {
  return {
    setIntervalFn: () => ({ unref() { return this; } }),
    clearIntervalFn: () => {},
    setTimeoutFn: () => ({ unref() { return this; } }),
    clearTimeoutFn: () => {},
  };
}

// Records the delays the adapter asks for, which is how the timing tests read the 2s stat backstop and
// the two watch debounces without waiting on any of them.
function recordingTimers() {
  const intervalDelays = [];
  const timeoutDelays = [];
  return {
    intervalDelays,
    timeoutDelays,
    setIntervalFn: (_fn, delay) => { intervalDelays.push(delay); return { unref() { return this; } }; },
    clearIntervalFn: () => {},
    setTimeoutFn: (_fn, delay) => { timeoutDelays.push(delay); return { unref() { return this; } }; },
    clearTimeoutFn: () => {},
  };
}

// Holds the drain open inside its first open(), so a test can call stop() with a read genuinely in
// flight rather than hoping to hit the window. Armed after start(), whose discovery reads each file's
// head sample and would otherwise be the read that gets held.
function gatedFs() {
  let release = null;
  let gate = null;
  return {
    arm: () => { gate = new Promise((resolve) => { release = resolve; }); },
    release: () => release(),
    fsPromises: {
      ...fs.promises,
      open: async (target, flags) => {
        if (gate) await gate;
        return fs.promises.open(target, flags);
      },
    },
  };
}

function withHome(fn) {
  return async () => {
    const home = makeHome();
    const events = [];
    const warnings = [];
    const adapters = [];
    const build = (overrides = {}) => {
      const adapter = createShellHistoryIngest({
        publish: (event) => events.push(event),
        env: home.env,
        platform: 'win32',
        logger: { warn: (message) => warnings.push(message) },
        ...inertTimers(),
        ...overrides,
      });
      adapters.push(adapter);
      return adapter;
    };
    try {
      await fn({ ...home, events, warnings, build });
    } finally {
      for (const adapter of adapters) adapter.stop();
      fs.rmSync(home.tmpDir, { recursive: true, force: true });
    }
  };
}

function seedPsReadLine(psDir, { host = 'ConsoleHost', lines = [] } = {}) {
  fs.mkdirSync(psDir, { recursive: true });
  const filePath = path.join(psDir, `${host}_history.txt`);
  fs.writeFileSync(filePath, lines.map((line) => `${line}\n`).join(''), 'utf8');
  return filePath;
}

function seedFish(fishDir, { entries = [] } = {}) {
  fs.mkdirSync(fishDir, { recursive: true });
  const filePath = path.join(fishDir, 'fish_history');
  fs.writeFileSync(filePath, entries.join(''), 'utf8');
  return filePath;
}

function fishEntry(cmd, when) {
  return `- cmd: ${cmd}\n  when: ${when}\n`;
}

function append(filePath, text) {
  fs.appendFileSync(filePath, text, 'utf8');
}

function summaries(events) {
  return events.map((event) => event.summary);
}

// --- EOF start and the happy path -----------------------------------------

test('a command accepted after start publishes, and the history before it never does', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm install', 'git push', 'npx vite build'] });

  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 1, 'the history file is tailed');
  await adapter.poll();
  assert.deepEqual(events, [], 'commands written before start() must never publish');

  append(filePath, 'npm run deploy\n');
  await adapter.poll();

  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'shellHistory');
  assert.equal(events[0].kind, 'command');
  assert.equal(events[0].summary, 'powershell: npm run deploy');
  assert.deepEqual(events[0].scope, { root: null, sessionId: null }, 'a history file records no cwd');
}));

test('a backtick-continued command reaches the ring as ONE event', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build();
  await adapter.start();

  append(filePath, 'git branch -vv |`\n  ForEach-Object {`\n    git branch -d $_`\n  }\n');
  await adapter.poll();

  assert.equal(events.length, 1, 'four physical lines are one command');
  // Raw at the adapter boundary: the lane's normalizeEvent scrubs before it folds, so the source must
  // not fold first. The folded ring form is asserted where it happens, further down this file.
  assert.equal(events[0].summary, 'powershell: git branch -vv |\n  ForEach-Object {\n    git branch -d $_\n  }');
  assert.equal(events[0].detail.lines, 4);
}));

test('a fish entry publishes with the timestamp its file recorded, not arrival time', withHome(async ({ fishDir, events, build }) => {
  const filePath = seedFish(fishDir, { entries: [fishEntry('npm install', 1699999999)] });
  const adapter = build({ nowFn: () => 5_000_000 });
  await adapter.start();
  assert.equal(adapter.trackedCount, 1);

  append(filePath, fishEntry('cargo build --release', 1700000000));
  await adapter.poll();

  assert.deepEqual(summaries(events), ['fish: cargo build --release']);
  assert.equal(events[0].ts, 1700000000000);
}));

test('a partial fish entry waits for its when line rather than publishing with the wrong time', withHome(async ({ fishDir, events, build }) => {
  const filePath = seedFish(fishDir, { entries: [fishEntry('npm install', 1699999999)] });
  const adapter = build();
  await adapter.start();

  append(filePath, '- cmd: cargo build\n');
  await adapter.poll();
  assert.deepEqual(events, [], 'the entry is incomplete');

  append(filePath, '  when: 1700000000\n');
  await adapter.poll();
  assert.deepEqual(summaries(events), ['fish: cargo build']);
}));

test('two PSReadLine hosts in one directory are two tails, and neither is tailed twice', withHome(async ({ psDir, events, build }) => {
  const consoleFile = seedPsReadLine(psDir, { host: 'ConsoleHost', lines: ['npm test'] });
  const codeFile = seedPsReadLine(psDir, { host: 'Visual Studio Code Host', lines: ['npm test'] });

  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 2);

  append(consoleFile, 'git commit -m "a"\n');
  append(codeFile, 'git commit -m "b"\n');
  await adapter.poll();
  // A second discovery must not re-seed either tail, or the same append would publish twice.
  await adapter.discover();
  await adapter.poll();

  assert.deepEqual(summaries(events).sort(), ['powershell: git commit -m "a"', 'powershell: git commit -m "b"']);
}));

// --- Noise rules -----------------------------------------------------------

test('a repeated command and a bare navigation command never reach the ring', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build();
  await adapter.start();

  append(filePath, 'npm run dev\nnpm run dev\nnpm run dev\ncls\ncd ..\nls\nnpm test\n');
  await adapter.poll();

  assert.deepEqual(summaries(events), ['powershell: npm run dev', 'powershell: npm test']);
}));

test('the duplicate gate survives across reads, so an up-arrow rerun on the next poll still collapses', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build();
  await adapter.start();

  append(filePath, 'npm run dev\n');
  await adapter.poll();
  append(filePath, 'npm run dev\n');
  await adapter.poll();

  assert.deepEqual(summaries(events), ['powershell: npm run dev']);
}));

// --- Rotation, truncation and catch-up -------------------------------------

test('a PSReadLine trim rewrite RE-BASELINES instead of replaying the whole file into the ring', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: Array.from({ length: 40 }, (_, index) => `command-${index}`) });
  const adapter = build();
  await adapter.start();

  // Exactly what PSReadLine does at MaximumHistoryCount: the file shrinks and is rewritten with the
  // retained history, none of which is new.
  fs.writeFileSync(filePath, Array.from({ length: 10 }, (_, index) => `command-${index + 30}\n`).join(''), 'utf8');
  await adapter.poll();
  assert.deepEqual(events, [], 'a rewrite is old history, not new commands');

  append(filePath, 'npm run deploy\n');
  await adapter.poll();
  assert.deepEqual(summaries(events), ['powershell: npm run deploy'], 'the tail resumed from the new end');
}));

test('a file deleted and recreated at the same path re-baselines rather than replaying it', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build();
  await adapter.start();

  fs.rmSync(filePath);
  fs.writeFileSync(filePath, 'sudo rm -rf /\nnpm ci\n', 'utf8');
  await adapter.poll();
  assert.deepEqual(events, [], 'a new file at a known path is a new baseline');

  append(filePath, 'npm run build\n');
  await adapter.poll();
  assert.deepEqual(summaries(events), ['powershell: npm run build']);
}));

test('a catch-up past the read bound publishes the newest commands and says how many it dropped', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build({ maxCatchUpBytes: 4096, maxCommandsPerDrain: 5 });
  await adapter.start();

  append(filePath, Array.from({ length: 400 }, (_, index) => `command-${index}\n`).join(''));
  await adapter.poll();

  assert.equal(events.length, 5, 'the per-drain bound held');
  assert.ok(events[0].summary.includes('earlier commands dropped'), events[0].summary);
  assert.ok(events[0].detail.droppedCommands > 0);
  assert.ok(!events[4].summary.includes('dropped'), 'the note rides the first surviving event only');
}));

/*
 * The drain bound applies to what SURVIVED the noise pipeline, never to the parsed lines ahead of it.
 * Slicing first left `context.previous` describing a command the drain had already dropped, so a survivor
 * identical to the one above it published as new: this fixture reported one lone `npm run watch` and
 * called the nine real commands before it dropped.
 */
test('the dup collapse sees every parsed command, so the drain bound cannot resurrect a repeat', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build();
  await adapter.start();

  const distinct = Array.from({ length: 9 }, (_, index) => `git commit -m fix-${index}`);
  const repeated = Array.from({ length: 51 }, () => 'npm run watch');
  append(filePath, [...distinct, ...repeated].map((line) => `${line}\n`).join(''));
  await adapter.poll();

  const published = summaries(events);
  assert.equal(published.length, 10, `nine real commands plus one watch: ${published.join(' | ')}`);
  assert.equal(published.filter((line) => line.endsWith('npm run watch')).length, 1);
  for (const command of distinct) {
    assert.ok(published.includes(`powershell: ${command}`), `${command} was dropped by the bound`);
  }
  assert.ok(!published.some((line) => line.includes('earlier commands dropped')), 'nothing publishable was dropped');
}));

// --- Discovery -------------------------------------------------------------

test('a shell with no history directory at all is silently absent, never an error', withHome(async ({ events, warnings, build }) => {
  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 0);
  assert.equal(adapter.isDisabled, false, 'an absent shell is absent, not a failure');
  await adapter.poll();
  assert.deepEqual(events, []);
  assert.deepEqual(warnings, []);
}));

test('a history file created after start is picked up by the next sweep and tailed from its end', withHome(async ({ psDir, events, build }) => {
  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 0);

  const filePath = seedPsReadLine(psDir, { lines: ['an old command', 'another old command'] });
  await adapter.discover();
  assert.equal(adapter.trackedCount, 1, 'the sweep found the file that did not exist at start');
  await adapter.poll();
  assert.deepEqual(events, [], 'a newly found file still starts at end of file');

  append(filePath, 'npm run dev\n');
  await adapter.poll();
  assert.deepEqual(summaries(events), ['powershell: npm run dev']);
}));

test('a deleted history file stops being tailed, but a vanished directory keeps its tails', withHome(async ({ psDir, fishDir, build }) => {
  const consoleFile = seedPsReadLine(psDir, { host: 'ConsoleHost', lines: ['npm test'] });
  seedPsReadLine(psDir, { host: 'Old', lines: ['npm test'] });
  seedFish(fishDir, { entries: [fishEntry('npm install', 1699999999)] });

  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 3);

  fs.rmSync(path.join(psDir, 'Old_history.txt'));
  await adapter.discover();
  assert.deepEqual(
    adapter.trackedFiles.map((filePath) => path.basename(filePath)).sort(),
    ['ConsoleHost_history.txt', 'fish_history'],
  );

  // A directory the sweep could not read says nothing about the files that were in it, so its tail
  // survives a temporarily unavailable path rather than being thrown away and re-baselined.
  fs.rmSync(fishDir, { recursive: true, force: true });
  await adapter.discover();
  assert.equal(adapter.trackedCount, 2);
  assert.ok(adapter.trackedFiles.includes(consoleFile));
}));

test('the tracked set is bounded, dropping the least recently written files first', withHome(async ({ psDir, build }) => {
  for (let index = 0; index < 6; index += 1) {
    const filePath = seedPsReadLine(psDir, { host: `Host${index}`, lines: ['npm test'] });
    fs.utimesSync(filePath, new Date(1700000000000 + index * 1000), new Date(1700000000000 + index * 1000));
  }
  const adapter = build({ maxTrackedFiles: 3 });
  await adapter.start();
  assert.equal(adapter.trackedCount, 3);
  assert.deepEqual(
    adapter.trackedFiles.map((filePath) => path.basename(filePath)).sort(),
    ['Host3_history.txt', 'Host4_history.txt', 'Host5_history.txt'],
  );
}));

// --- Timing and watching ---------------------------------------------------

test('the stat backstop interval comes from the resolved source config, not a constructor override', withHome(async ({ build }) => {
  const timers = recordingTimers();
  const adapter = build({ ...timers, sourceConfig: { pollMs: 750 }, discoverIntervalMs: 40000 });
  await adapter.start();
  assert.deepEqual(timers.intervalDelays, [750, 40000]);
}));

test('an append wakeup pokes a poll and only a rename schedules a sweep', withHome(async ({ psDir, build }) => {
  seedPsReadLine(psDir, { lines: ['npm test'] });
  const timers = recordingTimers();
  const handlers = [];
  const adapter = build({
    ...timers,
    watchFn: (_dir, _options, handler) => {
      handlers.push(handler);
      return { close() {}, on() {} };
    },
  });
  await adapter.start();
  assert.equal(handlers.length, 1, 'the PSReadLine directory is watched, not the file');

  timers.timeoutDelays.length = 0;
  handlers[0]('change', 'ConsoleHost_history.txt');
  assert.deepEqual(timers.timeoutDelays, [100], 'an append is a poll poke and nothing more');

  handlers[0]('rename', 'ConsoleHost_history.txt');
  assert.deepEqual(timers.timeoutDelays, [100, 500], 'only a rename is worth a sweep');
}));

test('a watcher that cannot be installed costs one warning and leaves the stat poll doing the work', withHome(async ({ psDir, events, warnings, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build({
    watchFn: () => { throw new Error('EPERM'); },
  });
  await adapter.start();
  await adapter.discover();
  await adapter.discover();

  assert.equal(adapter.isDisabled, false, 'a lost wakeup optimization never disables working ingestion');
  assert.equal(warnings.length, 1, 'once, not once per sweep');
  assert.ok(warnings[0].includes('stat poll'), warnings[0]);

  append(filePath, 'npm run dev\n');
  await adapter.poll();
  assert.deepEqual(summaries(events), ['powershell: npm run dev']);
}));

// --- Lifecycle -------------------------------------------------------------

test('stop() lands mid-read without publishing, and nothing in flight repopulates the state', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build();
  await adapter.start();
  append(filePath, 'npm run deploy\n');

  const gate = gatedFs();
  const stalled = build({ fsPromises: gate.fsPromises });
  await stalled.start();
  gate.arm();
  append(filePath, 'npm run other\n');
  const draining = stalled.poll();
  const stopped = stalled.stop();
  gate.release();
  await draining;
  await stopped;

  assert.equal(stalled.trackedCount, 0, 'stop() cleared the tails and the in-flight pass did not refill them');
  assert.deepEqual(events.filter((event) => event.summary.includes('npm run other')), []);
}));

test('a publish after stop() is impossible, because stop() forgets every tail', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build();
  await adapter.start();
  await adapter.stop();

  append(filePath, 'npm run deploy\n');
  await adapter.poll();
  assert.deepEqual(events, []);
  assert.equal(adapter.watchCount, 0);
}));

// --- Through the lane ------------------------------------------------------

test('the lane builds no shell-history adapter unless the source is explicitly enabled', () => {
  const laneOff = createIngestLane({ config: resolveIngestConfig({ enabled: true, sources: { terminal: { enabled: true } } }) });
  assert.equal(laneOff.shellHistoryEnabled, false);
  assert.equal(laneOff.shellHistory, null);
  laneOff.stop();

  const laneOn = createIngestLane({
    config: resolveIngestConfig({ enabled: true, sources: { shellHistory: { enabled: true } } }),
    shellHistoryOptions: { ...inertTimers(), env: {}, platform: 'win32' },
  });
  assert.equal(laneOn.shellHistoryEnabled, true);
  assert.equal(laneOn.shellHistory.name, 'shellHistory');
  laneOn.stop();
});

function laneWithShellHistory(env) {
  return createIngestLane({
    config: resolveIngestConfig({ enabled: true, sources: { shellHistory: { enabled: true } } }),
    shellHistoryOptions: { ...inertTimers(), platform: 'win32', env },
  });
}

test('a command reaches the rings and the digest labelled as machine scope', withHome(async ({ psDir, env }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const lane = laneWithShellHistory(env);
  try {
    await lane.shellHistory.start();
    append(filePath, 'npm run deploy\n');
    await lane.shellHistory.poll();

    const digest = lane.buildDigest({});
    assert.ok(digest.includes('npm run deploy'), digest);
    assert.ok(digest.includes('(machine scope)'), digest);
    // A project filter must never hide it: the command belongs to no project, so it belongs to all.
    assert.ok(lane.buildDigest({ scopes: ['C:\\some\\repo'] }).includes('npm run deploy'));
  } finally {
    lane.stop();
  }
}));

test('a secret-shaped command is scrubbed before it ever sits in a ring', withHome(async ({ psDir, env }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const lane = laneWithShellHistory(env);
  try {
    await lane.shellHistory.start();
    assert.equal(lane.shellHistory.trackedCount, 1, 'the temp PSReadLine directory resolved');

    append(filePath, '$env:GITHUB_TOKEN = "ghp_aaaabbbbccccdddd"\n');
    append(filePath, 'psql postgresql://app:hunter2@db.internal:5432/app\n');
    append(filePath, 'gh auth login --token ghp_zzzzzzzzzzzzzzzz\n');
    await lane.shellHistory.poll();

    const stored = lane.recentEvents().map((event) => event.summary).join('\n');
    assert.equal(lane.recentEvents().length, 3, 'every command still publishes, scrubbed');
    assert.ok(!stored.includes('ghp_aaaabbbbccccdddd'), stored);
    assert.ok(!stored.includes('hunter2'), stored);
    assert.ok(!stored.includes('ghp_zzzzzzzzzzzzzzzz'), stored);
    assert.ok(stored.includes('[scrubbed]'), stored);
  } finally {
    lane.stop();
  }
}));

/*
 * The scrub-ordering regression, pinned at ring level against the real path. The source must hand its
 * command on RAW so normalizeEvent can scrub before it folds and slices. When the source sliced first,
 * a quoted secret sitting past the slice point lost its closing quote, the scrub's quoted alternative
 * stopped matching, and its bare-token alternative took only the first WORD of the value: this exact
 * fixture stored `--password [scrubbed] two three four five` in the ring.
 */
test('a secret past a long prefix is scrubbed whole, never down to its first word', withHome(async ({ psDir, env }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const lane = laneWithShellHistory(env);
  try {
    await lane.shellHistory.start();
    append(filePath, `echo ${'a'.repeat(195)} --password "hunter two three four five six"\n`);
    await lane.shellHistory.poll();

    const [stored] = lane.recentEvents();
    assert.ok(stored.summary.includes('--password [scrubbed]'), stored.summary);
    for (const word of ['hunter', 'two three four five', 'six']) {
      assert.ok(!stored.summary.includes(word), `leaked ${word}: ${stored.summary}`);
    }
    assert.ok(stored.summary.endsWith('[scrubbed]'), 'the scrubbed value is the end of the line');
  } finally {
    lane.stop();
  }
}));

test('the ring is where a multi-line command is folded to one line and bounded', withHome(async ({ psDir, env }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const lane = laneWithShellHistory(env);
  try {
    await lane.shellHistory.start();
    append(filePath, 'git branch -vv |`\n  ForEach-Object {`\n  }\n');
    // Long enough that only the ring's own 400-char bound can cut it.
    append(filePath, `git commit -m "${'x'.repeat(600)}"\n`);
    await lane.shellHistory.poll();

    const stored = lane.recentEvents();
    const folded = stored.find((event) => event.summary.includes('ForEach-Object'));
    assert.equal(folded.summary, 'powershell: git branch -vv | ForEach-Object { }');
    assert.ok(!folded.summary.includes('\n'), 'no adapter may put a bare line into the digest');
    const long = stored.find((event) => event.summary.includes('git commit'));
    assert.equal(long.summary.length, 400, 'the ring bound is the one slice in the pipeline');
  } finally {
    lane.stop();
  }
}));

test('a shells list naming no known shell tails nothing and says so once', withHome(async ({ psDir, warnings, build }) => {
  seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build({ sourceConfig: { shells: ['nushell'] } });
  await adapter.start();
  await adapter.discover();

  assert.deepEqual(adapter.locations, [], 'a typo must not silently widen to the defaults');
  assert.equal(adapter.trackedCount, 0, 'the PowerShell history sitting right there is NOT tailed');
  assert.equal(warnings.length, 1, 'once, not once per sweep');
  assert.ok(warnings[0].includes('nushell'), warnings[0]);
  assert.ok(warnings[0].includes('no history file is tailed'), warnings[0]);
}));

test('an empty shells list still means the two zero-setup shells, and warns about nothing', withHome(async ({ psDir, warnings, build }) => {
  seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build({ sourceConfig: { shells: [] } });
  await adapter.start();

  assert.equal(adapter.trackedCount, 1, 'the recorded default is unchanged');
  assert.deepEqual(warnings, []);
}));
