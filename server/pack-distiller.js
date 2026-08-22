'use strict';

// The distiller lane: an LLM pass that REGENERATES derived summary files inside the pack source area
// when the sources they distill have drifted. Opt-in and off by default (config.packDistiller.enabled),
// plus `glissa pack distill` as the manual trigger, which is always allowed.
//
// The mill's deterministic assembly is untouched by design. This lane produces SOURCES: reviewable
// files that land under packs/ and show up in a plain `git diff`, and the mill still builds packs from
// files on disk with no model in the content path. The pack service's watcher sees the written file
// and rebuilds the pack on its own, so the two loops compose without knowing about each other.
//
// IO-FREE in the pr-poller sense: spec discovery, spec loading, hashing, reading the output, the spawn,
// the timers and the result reader are all injected, and the defaults just point at the real thing.
// Decisions (what the stamp says, whether it drifted, what the session is told) live in the pure
// server/core/distill-core.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerEphemeralSession } = require('./ephemeral-session');
const { buildDistillPrompt, buildStampLine, needsDistill } = require('./core/distill-core');
const { validatePackSpec } = require('./core/pack-core');
const {
  distillOutputPath, distillSourceHashes, listPackSpecs, loadPackSpec,
} = require('./pack-builder');

const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_TIMEOUT_SECONDS = 900;
// The install root: the directory carrying packs/, and the only cwd a distill session ever runs in.
const INSTALL_ROOT = path.resolve(__dirname, '..');

// Belt-and-suspenders deny-list for the headless distill sessions (they run under
// --dangerously-skip-permissions, so this is a guard, not the guard). The real guard is the prompt
// contract plus the post-verify below: a verdict is only believed once the written file parses to a
// stamp matching the sources that were read. The deny syntax cannot express "nothing outside packs/",
// so the write denials name the install root's own directories one by one, plus its root files.
const PACK_DISTILL_DENY = {
  deny: [
    'Bash(git commit:*)',
    'Bash(git push:*)',
    'Bash(git checkout:*)',
    'Bash(git rebase:*)',
    'Bash(gh:*)',
    'Bash(npm publish:*)',
    'Edit(*)',
    'Write(*)',
    'Edit(.github/**)',
    'Write(.github/**)',
    'Edit(.claude/**)',
    'Write(.claude/**)',
    'Edit(bin/**)',
    'Write(bin/**)',
    'Edit(detection/**)',
    'Write(detection/**)',
    'Edit(docs/**)',
    'Write(docs/**)',
    'Edit(notifications/**)',
    'Write(notifications/**)',
    'Edit(public/**)',
    'Write(public/**)',
    'Edit(scripts/**)',
    'Write(scripts/**)',
    'Edit(server/**)',
    'Write(server/**)',
    'Edit(session/**)',
    'Write(session/**)',
    'Edit(shared/**)',
    'Write(shared/**)',
    'Edit(tests/**)',
    'Write(tests/**)',
    'Edit(tools/**)',
    'Write(tools/**)',
    'Edit(packs/specs/**)',
    'Write(packs/specs/**)',
  ],
};

const RESULT_VERDICTS = new Set(['DISTILLED', 'NO_CHANGE', 'ERROR']);

function firstLine(text) {
  return String(text == null ? '' : text).split('\n')[0].trim();
}

/**
 * Read the verdict a distill session wrote to its result file. Missing or invalid means ERROR, so a
 * crashed or confused session never masquerades as a finished distill. The file is removed either way.
 */
function readDistillResult(resultPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const verdict = String(parsed.verdict || '').toUpperCase();
    if (!RESULT_VERDICTS.has(verdict)) return { verdict: 'ERROR', summary: 'invalid verdict in result file' };
    return { verdict, summary: firstLine(parsed.summary) };
  } catch {
    return { verdict: 'ERROR', summary: 'no result file' };
  } finally {
    try { fs.rmSync(resultPath, { force: true }); } catch { /* best-effort */ }
  }
}

// A Session only writes its `--settings` file when it has a hook router to point the hooks at, so the
// CLI path (no server, no hook listener) would spawn with no deny-list at all. This writes the
// permissions-only settings file for that case; the server lane gets the same deny-list through the
// Session's own hook settings instead.
function writeStandaloneDenySettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-distill-'));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: [...PACK_DISTILL_DENY.deny] } }, null, 2), 'utf8');
  return {
    args: ['--settings', settingsPath],
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

/**
 * The real spawn the distiller injects: one ephemeral headless `claude -p` session in the install
 * root, resolved when it exits. Never rejects. Used by the server lane (with the hook router, the
 * spawn gate and a lane map) and by the CLI (with none of them).
 */
function createDistillSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined,
  // Lane attribution: names this lane on the ledger when its headless session reports a Claude session id.
  recordLane = null,
} = {}) {
  return async function spawnDistill({ id, name, prompt, cwd, signal }) {
    // Required here, not at module load: the Session class resolves `claude` on PATH when it loads,
    // and `glissa pack distill --dry-run` spawns nothing and must not pay for that.
    const { Session } = require('../session/sessions');
    const standalone = hookRouter ? null : writeStandaloneDenySettings();
    const sess = new Session({
      id,
      name,
      path: cwd,
      dangerouslySkipPermissions: true,
      extraClaudeArgs: standalone ? ['-p', ...standalone.args] : ['-p'],
      initialPrompt: prompt,
      ephemeral: true,
      settingsPermissions: PACK_DISTILL_DENY,
      replayBufferKB,
      hookRouter,
      getHookPort,
    });
    registerEphemeralSession({ map: sessions, id, sess, closeSessionDataClients, logPrefix: 'pack-distill', name, recordLane });

    let onAbort = null;
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = () => { if (settled) return; settled = true; resolve(); };
        const fail = (err) => { if (settled) return; settled = true; reject(err); };
        sess.on('exit', done);
        sess.on('error', fail);
        if (signal) {
          onAbort = () => { try { sess.destroy(); } catch { /* already gone */ } done(); };
          if (signal.aborted) onAbort();
          if (!signal.aborted) signal.addEventListener('abort', onAbort, { once: true });
        }
        const run = () => (signal?.aborted ? undefined : sess.start());
        const started = spawnGate ? spawnGate.run(run) : Promise.resolve().then(run);
        started.catch(fail);
      });
    } finally {
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
      if (standalone) standalone.cleanup();
    }
  };
}

/**
 * @param {object} deps every side effect, injected. Defaults point at the real builder, the real
 *   spawn and the real timers, so `createPackDistiller({ enabled })` is the production wiring.
 */
function createPackDistiller(deps = {}) {
  const {
    enabled = false,
    listSpecs = () => listPackSpecs(),
    loadSpec = (specPath) => loadPackSpec(specPath),
    sourceHashes = (entry) => distillSourceHashes(entry),
    resolveOutput = (output) => distillOutputPath(output),
    readOutput = async (fullPath) => {
      try { return await fs.promises.readFile(fullPath, 'utf8'); } catch { return null; }
    },
    spawnDistill = createDistillSpawn(),
    resultPathFor = (packName, index) => path.join(os.tmpdir(), `glissa-distill-${packName}-${index}-${process.pid}.json`),
    readResult = readDistillResult,
    removeResult = (resultPath) => { try { fs.rmSync(resultPath, { force: true }); } catch { /* best-effort */ } },
    cwd = INSTALL_ROOT,
    intervalHours = DEFAULT_INTERVAL_HOURS,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    log = console,
  } = deps;

  let timer = null;
  let stopped = false;
  let tickRunning = false;
  // One chain, so an interval tick and a manual runOnce can never have two distill sessions writing
  // under packs/ at the same time. Distills are serialized by construction, never raced.
  let chain = Promise.resolve();

  function queue(task) {
    const run = chain.then(() => task());
    chain = run.catch(() => {});
    return run;
  }

  function report(pack, output, overrides) {
    return { pack, output, status: 'error', verdict: null, reason: null, summary: '', ...overrides };
  }

  // Race the spawn against a hard timeout, so a hung `claude -p` can never pin the lane. On timeout the
  // session is aborted (the spawn destroys it on the signal) and the entry resolves to ERROR.
  async function spawnWithTimeout(spawnArgs, resultPath) {
    const controller = new AbortController();
    let handle = null;
    const timeout = new Promise((resolve) => {
      handle = setTimeoutFn(() => {
        controller.abort();
        resolve({ verdict: 'ERROR', summary: 'distill timed out' });
      }, timeoutSeconds * 1000);
      if (handle && typeof handle.unref === 'function') handle.unref();
    });
    const run = Promise.resolve(spawnDistill({ ...spawnArgs, signal: controller.signal }))
      .then(() => readResult(resultPath))
      .catch((err) => ({ verdict: 'ERROR', summary: firstLine(err.message) }));
    const result = await Promise.race([run, timeout]);
    if (handle) clearTimeoutFn(handle);
    return result || { verdict: 'ERROR', summary: 'no verdict' };
  }

  async function distillEntry(spec, entry, index, { dryRun }) {
    const base = (overrides) => report(spec.name, entry.output, overrides);

    const outputPath = resolveOutput(entry.output);
    if (!outputPath) return base({ reason: 'output path escapes the packs directory' });

    let hashes;
    try {
      hashes = await sourceHashes(entry);
    } catch (err) {
      return base({ reason: `could not read sources: ${firstLine(err.message)}` });
    }
    if (hashes.length === 0) return base({ reason: 'distill sources matched no files' });

    const drift = needsDistill(hashes, await readOutput(outputPath));
    if (!drift.stale) return base({ status: 'current' });
    if (dryRun) return base({ status: 'stale', reason: drift.reason });

    const resultPath = resultPathFor(spec.name, index);
    removeResult(resultPath);
    const prompt = buildDistillPrompt({
      outputPath,
      sources: hashes,
      instructions: entry.instructions,
      resultPath,
      stampLine: buildStampLine(hashes),
    });

    let result;
    try {
      result = await spawnWithTimeout({
        id: `pack-distill:${spec.name}#${index}`,
        name: `distill ${spec.name} ${entry.output}`,
        prompt,
        cwd,
      }, resultPath);
    } finally {
      removeResult(resultPath);
    }
    if (result.verdict === 'ERROR') return base({ verdict: 'ERROR', reason: result.summary || 'distill failed' });

    // A verdict is a claim; the file on disk is the evidence. Re-running the same drift check against
    // what was actually written is what makes a lying or half-finished session an ERROR rather than a
    // silently accepted rewrite.
    const verify = needsDistill(hashes, await readOutput(outputPath));
    if (verify.stale) {
      return base({ verdict: result.verdict, reason: `verdict ${result.verdict} but ${verify.reason}` });
    }
    return base({ status: 'distilled', verdict: result.verdict, summary: result.summary });
  }

  async function runAll({ name = null, dryRun = false } = {}) {
    const reports = [];
    for (const spec of await listSpecs()) {
      if (stopped) break;
      if (name && spec.name !== name) continue;

      let loaded;
      try {
        loaded = await loadSpec(spec.specPath);
      } catch (err) {
        reports.push(report(spec.name, null, { reason: `could not read spec: ${firstLine(err.message)}` }));
        continue;
      }
      const entries = Array.isArray(loaded.distill) ? loaded.distill : [];
      if (entries.length === 0) continue;

      let hasEscapingOutput = false;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (resolveOutput(entry.output)) continue;
        hasEscapingOutput = true;
        reports.push(report(loaded.name || spec.name, entry.output, { reason: 'output path escapes the packs directory' }));
      }
      if (hasEscapingOutput) continue;

      const check = validatePackSpec(loaded);
      if (!check.ok) {
        reports.push(report(spec.name, null, { reason: `invalid spec: ${check.errors.join('; ')}` }));
        continue;
      }
      for (const [index, entry] of entries.entries()) {
        if (stopped) break;
        const entryReport = await distillEntry(loaded, entry, index, { dryRun });
        if (entryReport.status === 'error') {
          log.warn(`[distill] ${entryReport.pack} ${entryReport.output || ''}: ${entryReport.reason}`);
        }
        if (entryReport.status === 'distilled') {
          log.log(`[distill] ${entryReport.pack} rewrote ${entryReport.output}`);
        }
        reports.push(entryReport);
      }
    }
    return reports;
  }

  /** One full pass: drift-check every distill entry and regenerate the stale ones. Never throws. */
  async function runOnce(options = {}) {
    return queue(() => runAll(options));
  }

  async function tick() {
    if (tickRunning || stopped) return;
    tickRunning = true;
    try {
      await runOnce();
    } catch (err) {
      log.warn(`[distill] pass failed: ${firstLine(err.message)}`);
    } finally {
      tickRunning = false;
    }
  }

  async function start() {
    if (!enabled) return;
    stopped = false;
    timer = setIntervalFn(() => { void tick(); }, intervalHours * 3600000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    await tick();
  }

  // Async like the pack service's stop: a distill session may be mid-write under packs/, and shutdown
  // must not race it (the pack watcher would rebuild from a half-written file).
  async function stop() {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    await chain.catch(() => {});
  }

  return { start, stop, runOnce, isEnabled: () => enabled === true };
}

module.exports = {
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_TIMEOUT_SECONDS,
  INSTALL_ROOT,
  PACK_DISTILL_DENY,
  createDistillSpawn,
  createPackDistiller,
  readDistillResult,
};
