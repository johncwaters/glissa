'use strict';

// IO shell for the Mill tab (server/core/mill-core.js): read every pack spec, its published manifest
// and its distill drift, gather which live sessions were spawned against which pack, and hand it all
// to the pure assembler. Nothing is cached on disk and no timer runs: the Mill is a pull surface, so
// the only state here is the last report, replayed to a client that connects between requests.
//
// Fully async fs, like pack-builder: a spec can distill a whole docs tree, and every session shares
// one event loop.

const fsp = require('node:fs/promises');
const path = require('node:path');

const { needsDistill } = require('./core/distill-core');
const { buildMillReport } = require('./core/mill-core');
const { packConsumerSources } = require('./core/pack-core');
const { isPlainObject } = require('./core/usage-number-core');
const {
  defaultBuiltRoot,
  defaultSpecsDir,
  distillOutputPath,
  distillSourceHashes,
  listPackSpecs,
  loadPackSpec,
  readBuiltManifest,
  resolveBuiltPack,
  DEFAULT_PACKS_DIR,
} = require('./pack-builder');

function createMillWiring(deps = {}) {
  const {
    config = {},
    baseDir = DEFAULT_PACKS_DIR,
    specsDir = null,
    builtRoot = null,
    listSessions = () => [],
    getWatcherCount = () => null,
    now = Date.now,
    log = console,
  } = deps;

  let lastReport = null;
  let inFlight = null;
  // A request that lands mid-pass would otherwise be answered from bytes read before it arrived.
  let dirty = false;

  const resolvedSpecsDir = () => specsDir || defaultSpecsDir();
  const resolvedBuiltRoot = () => builtRoot || defaultBuiltRoot();

  async function readOutputFile(fullPath) {
    try {
      return await fsp.readFile(fullPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  // A paired phone is a remote client on the far side of this report, so a failure names the code and
  // at most a basename. An fs error's own message carries the absolute path it failed on.
  function safeFailureReason(error) {
    const code = typeof error?.code === 'string' && error.code ? error.code : null;
    const file = typeof error?.path === 'string' && error.path ? path.basename(error.path) : null;
    if (code && file) return `${code} on ${file}`;
    if (code) return code;
    if (file) return `read failed on ${file}`;
    return String(error?.message || 'read failed');
  }

  // A check that could not run reports its reason with stale null, so the tab says "check failed"
  // rather than claiming a derived file is current or drifted on evidence it never had.
  async function distillStatus(entry) {
    const output = String(entry?.output ?? '');
    try {
      const fullPath = distillOutputPath(output, { baseDir });
      if (!fullPath) return { output, stale: null, reason: 'output path resolves outside the packs directory' };
      const sources = await distillSourceHashes(entry, { baseDir });
      const verdict = needsDistill(sources, await readOutputFile(fullPath));
      return { output, stale: verdict.stale, reason: verdict.reason };
    } catch (error) {
      return { output, stale: null, reason: safeFailureReason(error) };
    }
  }

  async function readSpecEntry({ name, specPath }) {
    const entry = { name, spec: null, specError: null, manifest: null, builtReason: null, distill: [] };
    try {
      entry.spec = await loadPackSpec(specPath);
    } catch (error) {
      entry.specError = `could not read spec: ${safeFailureReason(error)}`;
      return entry;
    }
    // Valid JSON that is not an object (a bare null, an array, a number) parses without throwing, and
    // every read below dereferences it.
    if (!isPlainObject(entry.spec)) {
      entry.spec = null;
      entry.specError = 'spec file is not a JSON object';
      return entry;
    }
    entry.manifest = await readBuiltManifest(name, { builtRoot: resolvedBuiltRoot() });
    if (!entry.manifest) {
      const resolved = await resolveBuiltPack(name, { builtRoot: resolvedBuiltRoot() });
      entry.builtReason = resolved.reason;
    }
    for (const distill of Array.isArray(entry.spec.distill) ? entry.spec.distill : []) {
      entry.distill.push(await distillStatus(distill));
    }
    return entry;
  }

  function sessionRows() {
    const rows = [];
    for (const snapshot of listSessions()) {
      if (!Array.isArray(snapshot?.packs) || snapshot.packs.length === 0) continue;
      rows.push({
        sessionId: snapshot.id,
        sessionName: snapshot.name,
        state: snapshot.state,
        packs: snapshot.packs,
      });
    }
    return rows;
  }

  async function buildReport() {
    const specs = [];
    for (const spec of await listPackSpecs({ specsDir: resolvedSpecsDir() })) {
      specs.push(await readSpecEntry(spec));
    }
    return buildMillReport({
      ts: now(),
      requestId: null,
      autoRebuild: config.packsAutoRebuild !== false,
      distillerEnabled: config.packDistiller?.enabled === true,
      watcherCount: getWatcherCount(),
      specs,
      sessionRows: sessionRows(),
      // The SAME enumeration the build gate reads, so the tab and the mill can never disagree about
      // what counts as a consumer.
      consumerSources: packConsumerSources(config),
    });
  }

  /*
   * A pass, plus at most one FOLLOW-UP pass when a request landed while the first was running. A
   * rebuild is exactly what a client asks about, so answering a mid-pass request from bytes read
   * before it arrived reports the state it was asking whether had changed. The bound is one: a chain
   * that re-ran for every late arrival would never settle under a polling client.
   */
  async function runPasses() {
    const first = await buildReport();
    if (!dirty) return first;
    dirty = false;
    return buildReport();
  }

  /*
   * The pulled half of the protocol. Clients asking at once share the pass: the walk touches every
   * spec's sources for the drift check, which is the one expensive thing this surface does.
   */
  async function requestReport(msg, send) {
    const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
    if (inFlight) dirty = true;
    if (!inFlight) {
      dirty = false;
      inFlight = runPasses().finally(() => { inFlight = null; });
    }
    try {
      const report = await inFlight;
      lastReport = { ...report, requestId: null };
      send({ ...report, requestId });
    } catch (error) {
      log.warn(`[mill] report failed: ${error.message}`);
      send({ type: 'mill-report', requestId, ts: now(), error: String(error.message) });
    }
  }

  /*
   * The pack names a spec file actually defines. The control plane validates an assignment against
   * this rather than against the built packs: a spec that has never been built is exactly what a first
   * assignment is for, since assigning it is what makes the mill build it.
   */
  async function listPackNames() {
    const specs = await listPackSpecs({ specsDir: resolvedSpecsDir() });
    return specs.map((spec) => spec.name);
  }

  return {
    requestReport,
    listPackNames,
    getCachedReport: () => lastReport,
  };
}

module.exports = { createMillWiring };
