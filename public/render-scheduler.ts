const DEFAULT_BUDGET = 6;
const DEFAULT_MAX_CHUNK = 256 * 1024;

export type TerminalSinkWrite = (data: string, onDrained: () => void) => void;

interface TerminalSink {
  write: TerminalSinkWrite;
  pending: string[];
  readIdx: number;
  pendingBytes: number;
  inFlight: boolean;
  dirty: boolean;
  live: boolean;
}

export interface SchedulerOptions {
  budget?: number;
  maxChunkBytes?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

export function createScheduler({
  budget = DEFAULT_BUDGET,
  maxChunkBytes = DEFAULT_MAX_CHUNK,
  requestFrame,
  cancelFrame,
}: SchedulerOptions = {}) {
  const raf = requestFrame || ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
  const caf = cancelFrame || ((id: number) => cancelAnimationFrame(id));

  const sinks = new Map<string, TerminalSink>();
  const order: string[] = [];
  let rr = 0;
  let frameId: number | null = null;

  function arm() {
    if (frameId === null) frameId = raf(tick);
  }

  function serviceable(s: TerminalSink | undefined): s is TerminalSink {
    return !!(s?.live && s.dirty && !s.inFlight && s.pendingBytes > 0);
  }

  function anyServiceable() {
    for (const s of sinks.values()) if (serviceable(s)) return true;
    return false;
  }

  function tick() {
    frameId = null;
    const n = order.length;
    let serviced = 0;
    for (let k = 0; k < n && serviced < budget; k++) {
      const id = order[(rr + k) % n];
      const s = sinks.get(id);
      if (!serviceable(s)) continue;

      const COMPACT_THRESHOLD = 64;
      let acc = '';
      let consumed = 0;
      while (s.readIdx < s.pending.length) {
        const next = s.pending[s.readIdx];
        const remaining = maxChunkBytes - acc.length;
        if (acc.length + next.length <= maxChunkBytes) {
          acc += next;
          consumed += next.length;
          s.readIdx++;
          continue;
        }

        if (acc.length === 0) {
          acc = next.slice(0, remaining);
          consumed += remaining;
          s.pending[s.readIdx] = next.slice(remaining);
        }

        break;
      }
      s.pendingBytes -= consumed;

      if (s.pendingBytes === 0) {
        s.pending.length = 0;
        s.readIdx = 0;
        s.dirty = false;
      }
      if (s.pendingBytes > 0 && s.readIdx >= COMPACT_THRESHOLD) {
        s.pending.splice(0, s.readIdx);
        s.readIdx = 0;
      }

      s.inFlight = true;
      s.write(acc, () => {
        if (!s.live) return;
        s.inFlight = false;
        if (s.pendingBytes > 0) {
          s.dirty = true;
          arm();
        }
      });
      serviced++;
    }
    if (n > 0) rr = (rr + 1) % n;
    if (anyServiceable()) arm();
  }

  return {
    register(id: string, write: TerminalSinkWrite) {
      const existing = sinks.get(id);
      if (existing) {
        existing.write = write;
        existing.live = true;
        return;
      }
      sinks.set(id, { write, pending: [], readIdx: 0, pendingBytes: 0, inFlight: false, dirty: false, live: true });
      order.push(id);
    },
    unregister(id: string) {
      const s = sinks.get(id);
      if (!s) return;
      s.live = false;
      sinks.delete(id);
      const idx = order.indexOf(id);
      if (idx !== -1) order.splice(idx, 1);
      if (rr >= order.length) rr = 0;
    },
    enqueue(id: string, data: string) {
      const s = sinks.get(id);
      if (!s || !data) return;
      s.pending.push(data);
      s.pendingBytes += data.length;
      s.dirty = true;
      arm();
    },
    has(id: string) {
      return sinks.has(id);
    },
    size() {
      return sinks.size;
    },
    running() {
      return frameId !== null;
    },
    stop() {
      if (frameId !== null) {
        caf(frameId);
        frameId = null;
      }
    },
  };
}

export const renderScheduler = createScheduler();
