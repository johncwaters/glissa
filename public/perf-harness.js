// Dev-only synthetic load harness for terminal-responsiveness measurement.
//
// BROWSER-RUN: open `/perf.html` under `npm run dev`. It is NOT part of the
// production build (perf.html is not a build entry, so this module is never
// bundled into index) and is NOT headlessly verified — it is a manual
// measurement tool for the Phase 1 / Phase 2 gate.
//
// It drives K real xterm terminals with dense ANSI corpus at a controlled rate
// and reports the two browser-side gate metrics:
//   T8 = longest main-thread task during the burst (PerformanceObserver longtask)
//   T9 = echo latency p95 (a small write timed through parse-drain + next paint,
//        while all K terminals are under bulk load)
// It writes via `term.write(data, cb)`, so it also exercises the parse-drain
// callback that the Phase 2 backpressure design is built on.

import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { generateCorpus } from './perf-corpus.mjs';

function makeTerminal(mountInto, useWebgl) {
  const term = new Terminal({ fontSize: 14, scrollback: 5000, allowProposedApi: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(mountInto);
  if (useWebgl) {
    try {
      const addon = new WebglAddon();
      // Mirror the dashboard: on context loss, dispose so xterm falls back to
      // its canvas/DOM renderer instead of freezing (what an uncapped run does).
      addon.onContextLoss(() => { try { addon.dispose(); } catch { /* ignore */ } });
      term.loadAddon(addon);
    } catch { /* canvas fallback */ }
  }
  try { fit.fit(); } catch { /* ignore */ }
  return term;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

const round2 = (n) => Math.round(n * 100) / 100;

// Drive K terminals for `durationMs`; resolves to the metrics object.
export function runStress(opts = {}) {
  const {
    sessions = 6,
    durationMs = 10000,
    linesPerTick = 8,
    seed = 1,
    echoEveryMs = 120,
    container = document.body,
    webglCap = 12, // mirror MAX_WEBGL_CONTEXTS in session-card.js; set >= sessions to reproduce the uncapped freeze
    strategy = 'naive', // 'naive' = write every terminal every frame; 'gated' = callback-gated round-robin
    budgetPerFrame = sessions, // 'gated' only: max terminals serviced per frame (= sessions -> Option B; < sessions -> Option A bounded)
  } = opts;

  const grid = document.createElement('div');
  grid.style.cssText =
    'display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:8px;';
  container.appendChild(grid);

  const terms = [];
  let webglTerms = 0;
  for (let i = 0; i < sessions; i++) {
    const cell = document.createElement('div');
    cell.style.cssText = 'height:260px;overflow:hidden;border:1px solid #333;';
    grid.appendChild(cell);
    const useWebgl = i < webglCap;
    if (useWebgl) webglTerms++;
    terms.push(makeTerminal(cell, useWebgl));
  }

  // T8: longest main-thread task.
  let maxTask = 0;
  let taskCount = 0;
  let obs = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        taskCount++;
        if (e.duration > maxTask) maxTask = e.duration;
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch { /* longtask unsupported in this browser */ }

  // One dense chunk per terminal (re-parsed each frame = sustained load).
  const corpus = [];
  for (let i = 0; i < sessions; i++) corpus.push(generateCorpus(linesPerTick, seed + i));

  let totalBytes = 0;
  let frames = 0;
  const echoLatencies = [];
  let lastEcho = 0;
  // Sub-50ms jank signals the longtask API (50ms floor) cannot see:
  // frame gaps far above the refresh interval = dropped frames; write-loop
  // time = synchronous dispatch cost per frame.
  let prevTs = 0;
  let maxFrameGap = 0;
  const frameGaps = [];
  let maxWriteLoop = 0;
  // Per-terminal input vs parse-drain. (written - drained) = bytes still queued
  // in that terminal's internal xterm write buffer = its real backlog depth.
  const bytesWritten = new Array(sessions).fill(0);
  const bytesDrained = new Array(sessions).fill(0);
  // 'gated' strategy state: per-terminal source backlog + one-in-flight gate.
  const bytesSource = new Array(sessions).fill(0);
  const pending = new Array(sessions).fill('');
  const inFlight = new Array(sessions).fill(false);
  let rrPointer = 0;

  // Feed one frame's worth of source into the terminals per the chosen strategy.
  // 'naive': write every terminal every frame regardless of whether it kept up
  //   (models an unthrottled feed -> N parsers flood the main thread).
  // 'gated': source accrues per terminal; each frame service up to budgetPerFrame
  //   terminals round-robin, each only when its prior write has DRAINED (one
  //   in-flight). budget == sessions is Option B (per-session backpressure);
  //   budget < sessions adds Option A's bounded per-frame coordination.
  function feedFrame() {
    if (strategy === 'naive') {
      for (let i = 0; i < terms.length; i++) {
        const n = corpus[i].length;
        totalBytes += n;
        bytesSource[i] += n;
        bytesWritten[i] += n;
        terms[i].write(corpus[i], () => { bytesDrained[i] += n; });
      }
      return;
    }
    for (let i = 0; i < terms.length; i++) {
      totalBytes += corpus[i].length;
      bytesSource[i] += corpus[i].length;
      pending[i] += corpus[i];
    }
    let serviced = 0;
    for (let k = 0; k < terms.length && serviced < budgetPerFrame; k++) {
      const i = (rrPointer + k) % terms.length;
      if (inFlight[i] || pending[i].length === 0) continue;
      const chunk = pending[i];
      pending[i] = '';
      inFlight[i] = true;
      bytesWritten[i] += chunk.length;
      terms[i].write(chunk, () => { bytesDrained[i] += chunk.length; inFlight[i] = false; });
      serviced++;
    }
    rrPointer = (rrPointer + 1) % terms.length;
  }

  return new Promise((resolve) => {
    const start = performance.now();
    let rafId = null;

    function finish(now) {
      if (obs) obs.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      const sorted = echoLatencies.slice().sort((a, b) => a - b);
      const perTerm = terms.map((t, i) => ({
        i,
        renderer: i < webglCap ? 'webgl' : 'canvas',
        sourceKB: round2(bytesSource[i] / 1024),
        writtenKB: round2(bytesWritten[i] / 1024),
        drainedKB: round2(bytesDrained[i] / 1024),
        pendingKB: round2((bytesSource[i] - bytesWritten[i]) / 1024), // held by the scheduler, not yet fed (terminal lag)
        xtermBacklogKB: round2((bytesWritten[i] - bytesDrained[i]) / 1024), // fed but not yet parsed
        lines: t.buffer?.active?.length ?? 0,
      }));
      let maxBacklogKB = 0;
      for (const p of perTerm) if (p.xtermBacklogKB > maxBacklogKB) maxBacklogKB = p.xtermBacklogKB;
      const metrics = {
        sessions,
        strategy,
        budgetPerFrame: strategy === 'gated' ? budgetPerFrame : null,
        webglTerms, // on WebGL; the rest (sessions - webglTerms) use canvas
        canvasTerms: sessions - webglTerms,
        maxBacklogKB, // worst per-terminal undrained xterm buffer
        perTerm,
        durationMs: Math.round(now - start),
        frames,
        longestTaskMs: round2(maxTask), // T8 (only tasks > 50ms; 0 = none crossed the floor)
        longTaskCount: taskCount,
        maxWriteLoopMs: round2(maxWriteLoop), // synchronous write-dispatch cost / frame
        maxFrameGapMs: round2(maxFrameGap), // worst dropped-frame gap (jank below the 50ms floor)
        p95FrameGapMs: round2(percentile(frameGaps.slice().sort((a, b) => a - b), 95)),
        mbWritten: round2(totalBytes / 1048576),
        echoP50Ms: round2(percentile(sorted, 50)),
        echoP95Ms: round2(percentile(sorted, 95)), // T9
        echoSamples: sorted.length,
      };
      console.table(metrics);
      resolve(metrics);
    }

    function tick(now) {
      frames++;
      if (prevTs) {
        const gap = now - prevTs;
        frameGaps.push(gap);
        if (gap > maxFrameGap) maxFrameGap = gap;
      }
      prevTs = now;
      const w0 = performance.now();
      feedFrame();
      const wDur = performance.now() - w0;
      if (wDur > maxWriteLoop) maxWriteLoop = wDur;
      // Echo probe: time a small write through parse-drain + next paint while
      // every terminal is under bulk load.
      if (now - lastEcho >= echoEveryMs) {
        lastEcho = now;
        const t0 = performance.now();
        terms[0].write('\x1b[7mX\x1b[0m', () => {
          requestAnimationFrame(() => echoLatencies.push(performance.now() - t0));
        });
      }
      if (now - start >= durationMs) { finish(now); return; }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  });
}
