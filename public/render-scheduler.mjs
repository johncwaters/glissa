// Global terminal RENDER scheduler — Option A: callback-gated round-robin with a
// per-frame terminal budget. (Distinct from the root scheduler.js, which is a
// calendar/cron that fires team runs — this one schedules xterm WRITES per frame.)
//
// Empirically the best feed strategy under heavy multi-session load (see
// .omc/plans/perf-responsiveness.md): vs the old per-session throttle it cut echo
// p95 ~3.7x and DOUBLED rendered throughput at 20 streaming terminals, by bounding
// aggregate per-frame parse work instead of letting N independent xterm parsers
// saturate the shared main thread.
//
// One module-level RAF loop owns every terminal. Each session enqueues inbound
// bytes; per frame the loop services up to `budget` dirty terminals round-robin,
// each gated by xterm's write-drain callback (one in-flight write per terminal),
// carrying leftovers to the next frame. The loop parks when nothing is dirty.
//
// `.mjs` so it is ESM in both Vite (browser) and Node (tests dynamic-import it);
// the project is type:commonjs, so a plain `.js` with `export` loads as CJS in Node.

const DEFAULT_BUDGET = 6; // terminals serviced per frame
const DEFAULT_MAX_CHUNK = 256 * 1024; // bytes per single write (anti-monopoly cap)

export function createScheduler({
  budget = DEFAULT_BUDGET,
  maxChunkBytes = DEFAULT_MAX_CHUNK,
  requestFrame,
  cancelFrame,
} = {}) {
  const raf = requestFrame || ((cb) => requestAnimationFrame(cb));
  const caf = cancelFrame || ((id) => cancelAnimationFrame(id));

  const sinks = new Map(); // id -> { write, pending, inFlight, dirty, live }
  const order = []; // ids in round-robin order
  let rr = 0;
  let frameId = null;

  function arm() {
    if (frameId === null) frameId = raf(tick);
  }

  function serviceable(s) {
    return !!(s?.live && s.dirty && !s.inFlight && s.pending.length > 0);
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
      let chunk;
      if (s.pending.length > maxChunkBytes) {
        chunk = s.pending.slice(0, maxChunkBytes);
        s.pending = s.pending.slice(maxChunkBytes); // stays dirty (more to send)
      } else {
        chunk = s.pending;
        s.pending = '';
        s.dirty = false;
      }
      s.inFlight = true;
      s.write(chunk, () => {
        if (!s.live) return; // sink unregistered while this write was in flight
        s.inFlight = false;
        if (s.pending.length > 0) {
          s.dirty = true;
          arm();
        }
      });
      serviced++;
    }
    if (n > 0) rr = (rr + 1) % n; // rotate the start each frame for fairness
    if (anyServiceable()) arm();
  }

  return {
    register(id, write) {
      const existing = sinks.get(id);
      if (existing) {
        existing.write = write;
        existing.live = true;
        return;
      }
      sinks.set(id, { write, pending: '', inFlight: false, dirty: false, live: true });
      order.push(id);
    },
    unregister(id) {
      const s = sinks.get(id);
      if (!s) return;
      s.live = false; // guard any in-flight write callback still pending
      sinks.delete(id);
      const idx = order.indexOf(id);
      if (idx !== -1) order.splice(idx, 1);
      if (rr >= order.length) rr = 0;
    },
    enqueue(id, data) {
      const s = sinks.get(id);
      if (!s || !data) return;
      s.pending += data;
      s.dirty = true;
      arm();
    },
    has(id) {
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

// App-wide singleton (uses global requestAnimationFrame).
export const renderScheduler = createScheduler();
