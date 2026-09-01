// Pure ring buffer of recent PTY output chunks, extracted verbatim from Session.
// Uses a head-index ring instead of Array.shift() (O(n) per call) to keep the hot
// path O(1) amortized. `total` is a monotonic count of bytes ever produced (never
// decremented by eviction): it is the "end" offset for since(); per-client
// ws-senders track how far they have durably sent against it so a backpressure
// drop can be backfilled. Byte counts are JS string .length units (UTF-16 code
// units) throughout. State fields are public for white-box tests.

interface OutputRingSlice {
  data: string;
  base: number;
  end: number;
  evicted: boolean;
}

interface OutputRingStats {
  entries: number;
  bytes: number;
  total: number;
}

interface OutputRing {
  chunks: (string | null)[];
  head: number;
  size: number;
  max: number;
  total: number;
  push(data: string): void;
  replay(): string;
  since(offset: number): OutputRingSlice;
  reset(): void;
  setMax(bytes: number): void;
  stats(): OutputRingStats;
}

function createOutputRing(maxBytes: number): OutputRing {
  const chunks: (string | null)[] = [];
  return {
    chunks,
    head: 0, // index of oldest valid entry; advances instead of shift()
    size: 0,
    max: maxBytes,
    total: 0,

    push(data) {
      this.chunks.push(data);
      this.size += data.length;
      this.total += data.length;
      while (this.size > this.max && this.chunks.length - this.head > 1) {
        const oldestChunk = this.chunks[this.head];
        if (oldestChunk === null) throw new TypeError("output ring head cannot be empty");
        this.size -= oldestChunk.length;
        this.chunks[this.head] = null;
        this.head++;
      }
      if (this.head > 1024) {
        this.chunks = this.chunks.slice(this.head);
        this.head = 0;
      }
    },

    replay() {
      if (this.head === 0) return this.chunks.join("");
      return this.chunks.slice(this.head).join("");
    },

    // Slice of output produced at or after `offset`. Returns { data, base, end, evicted }:
    //   - end  = current total (the offset the caller should adopt after consuming).
    //   - base = oldest retained offset (bytes evicted before it).
    //   - offset >= end  -> nothing new (empty data).
    //   - offset < base  -> the requested range was partially evicted; data is the
    //                       full current replay and `evicted` is true (caller must
    //                       screen-clear before writing it).
    //   - otherwise      -> the exact tail from `offset`, slicing the boundary chunk.
    // `offset` is always a previous cumulative .length (a chunk-append boundary), never an
    // arbitrary mid-chunk index, so the boundary slice never splits a UTF-16 surrogate pair.
    since(offset) {
      const end = this.total;
      const base = end - this.size;
      if (offset >= end) return { data: "", base, end, evicted: false };
      if (offset < base) return { data: this.replay(), base, end, evicted: true };
      let pos = base;
      let out = "";
      for (let i = this.head; i < this.chunks.length; i++) {
        const chunk = this.chunks[i];
        if (chunk == null) continue; // eviction nulls entries before head compaction
        const len = chunk.length;
        if (pos + len <= offset) {
          pos += len;
          continue;
        }
        out += offset > pos ? chunk.slice(offset - pos) : chunk;
        pos += len;
      }
      return { data: out, base, end, evicted: false };
    },

    // Full reset (PTY restart re-bases the monotonic offset at 0).
    reset() {
      this.chunks = [];
      this.head = 0;
      this.size = 0;
      this.total = 0;
    },

    setMax(bytes) {
      this.max = bytes;
    },

    stats() {
      return { entries: this.chunks.length - this.head, bytes: this.size, total: this.total };
    },
  };
}

export { createOutputRing };
export type { OutputRing, OutputRingSlice, OutputRingStats };
