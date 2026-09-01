
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { generateCorpus } from './perf-corpus.ts';

function makeTerminal(mountInto: HTMLElement, useWebgl: boolean) {
  const term = new Terminal({ fontSize: 14, scrollback: 5000, allowProposedApi: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(mountInto);
  if (useWebgl) {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => { try { addon.dispose(); } catch {  } });
      term.loadAddon(addon);
    } catch {  }
  }
  try { fit.fit(); } catch {  }
  return term;
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface StressOptions {
  sessions?: number;
  durationMs?: number;
  linesPerTick?: number;
  seed?: number;
  echoEveryMs?: number;
  container?: HTMLElement;
  webglCap?: number;
  strategy?: string;
  budgetPerFrame?: number;
}

export function runStress(opts: StressOptions = {}) {
  const {
    sessions = 6,
    durationMs = 10000,
    linesPerTick = 8,
    seed = 1,
    echoEveryMs = 120,
    container = document.body,
    webglCap = 12,
    strategy = 'naive',
    budgetPerFrame = sessions,
  } = opts;

  const grid = document.createElement('div');
  grid.style.cssText =
    'display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:8px;';
  container.appendChild(grid);

  const terms: Terminal[] = [];
  let webglTerms = 0;
  for (let i = 0; i < sessions; i++) {
    const cell = document.createElement('div');
    cell.style.cssText = 'height:260px;overflow:hidden;border:1px solid #333;';
    grid.appendChild(cell);
    const useWebgl = i < webglCap;
    if (useWebgl) webglTerms++;
    terms.push(makeTerminal(cell, useWebgl));
  }

  let maxTask = 0;
  let taskCount = 0;
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        taskCount++;
        if (e.duration > maxTask) maxTask = e.duration;
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch {  }

  const corpus: string[] = [];
  for (let i = 0; i < sessions; i++) corpus.push(generateCorpus(linesPerTick, seed + i));

  let totalBytes = 0;
  let frames = 0;
  const echoLatencies: number[] = [];
  let lastEcho = 0;
  let prevTs = 0;
  let maxFrameGap = 0;
  const frameGaps: number[] = [];
  let maxWriteLoop = 0;
  const bytesWritten: number[] = new Array(sessions).fill(0);
  const bytesDrained: number[] = new Array(sessions).fill(0);
  const bytesSource: number[] = new Array(sessions).fill(0);
  const pending: string[] = new Array(sessions).fill('');
  const inFlight: boolean[] = new Array(sessions).fill(false);
  let rrPointer = 0;

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
    let rafId: number | null = null;

    function finish(now: number) {
      if (obs) obs.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      const sorted = echoLatencies.slice().sort((a, b) => a - b);
      const perTerm = terms.map((t, i) => ({
        i,
        renderer: i < webglCap ? 'webgl' : 'canvas',
        sourceKB: round2(bytesSource[i] / 1024),
        writtenKB: round2(bytesWritten[i] / 1024),
        drainedKB: round2(bytesDrained[i] / 1024),
        pendingKB: round2((bytesSource[i] - bytesWritten[i]) / 1024),
        xtermBacklogKB: round2((bytesWritten[i] - bytesDrained[i]) / 1024),
        lines: t.buffer?.active?.length ?? 0,
      }));
      let maxBacklogKB = 0;
      for (const p of perTerm) if (p.xtermBacklogKB > maxBacklogKB) maxBacklogKB = p.xtermBacklogKB;
      const metrics = {
        sessions,
        strategy,
        budgetPerFrame: strategy === 'gated' ? budgetPerFrame : null,
        webglTerms,
        canvasTerms: sessions - webglTerms,
        maxBacklogKB,
        perTerm,
        durationMs: Math.round(now - start),
        frames,
        longestTaskMs: round2(maxTask),
        longTaskCount: taskCount,
        maxWriteLoopMs: round2(maxWriteLoop),
        maxFrameGapMs: round2(maxFrameGap),
        p95FrameGapMs: round2(percentile(frameGaps.slice().sort((a, b) => a - b), 95)),
        mbWritten: round2(totalBytes / 1048576),
        echoP50Ms: round2(percentile(sorted, 50)),
        echoP95Ms: round2(percentile(sorted, 95)),
        echoSamples: sorted.length,
      };
      console.table(metrics);
      resolve(metrics);
    }

    function tick(now: number) {
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
