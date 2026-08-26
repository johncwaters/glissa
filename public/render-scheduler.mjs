// Global terminal RENDER scheduler, Option A: callback-gated round-robin with a
// per-frame terminal budget. It schedules xterm WRITES per frame.
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

/**
 * @param {{
 *   budget?: number,
 *   maxChunkBytes?: number,
 *   requestFrame?: (callback: FrameRequestCallback) => number,
 *   cancelFrame?: (handle: number) => void,
 * }} [options]
 */
export function createScheduler({
  budget = DEFAULT_BUDGET,
  maxChunkBytes = DEFAULT_MAX_CHUNK,
  requestFrame,
  cancelFrame,
} = {}) {
  const raf = requestFrame || ((cb) => requestAnimationFrame(cb));
  const caf = cancelFrame || ((id) => cancelAnimationFrame(id));

  const sinks = new Map(); // id -> { write, pending: string[], readIdx, pendingBytes, inFlight, dirty, live }
  const order = []; // ids in round-robin order
  let rr = 0;
  let frameId = null;

  function arm() {
    if (frameId === null) frameId = raf(tick);
  }

  function serviceable(s) {
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

      // Build the chunk to write by consuming from the pending array via a read-index cursor.
      // readIdx advances over fully consumed chunks; the array is compacted (splice) when the
      // queue drains or the cursor exceeds a threshold. This avoids O(n) per-service shift()
      // on a deep backlog while preserving byte-exact semantics:
      //   - Under-cap: all pending chunks coalesce into one write per service.
      //   - Over-cap: whole chunks are consumed up to maxChunkBytes; a single chunk that
      //     would overflow alone is split (head sent, remainder written back at readIdx);
      //     an acc that has content but can't fit the next chunk stops without splitting.
      // The existing tests pin this boundary: enqueue('abcdefg') cap=4 -> 'abcd' then 'efg'.
      const COMPACT_THRESHOLD = 64; // splice off consumed prefix when cursor passes this
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
        // next would overflow. If acc is empty this is a single oversized chunk: split it,
        // write the remainder back in place at the cursor position.
        if (acc.length === 0) {
          acc = next.slice(0, remaining);
          consumed += remaining;
          s.pending[s.readIdx] = next.slice(remaining);
          // do NOT advance readIdx: the remainder stays at the same slot for next service
        }
        // acc has content (or oversized split handled): send what we have.
        break;
      }
      s.pendingBytes -= consumed;
      // Compact: when the queue drains, reset fully (dirty=false). When the read cursor
      // has grown past the threshold, splice off the consumed prefix to bound memory.
      // The drain branch is the common fast-path; the threshold splice is the safety valve
      // on deep backlogs. Both reset readIdx to 0 so the next service starts at the front.
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
        if (!s.live) return; // sink unregistered while this write was in flight
        s.inFlight = false;
        if (s.pendingBytes > 0) {
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
      sinks.set(id, { write, pending: [], readIdx: 0, pendingBytes: 0, inFlight: false, dirty: false, live: true });
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
      s.pending.push(data);
      s.pendingBytes += data.length;
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
