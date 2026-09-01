
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
    head: 0,
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

    since(offset) {
      const end = this.total;
      const base = end - this.size;
      if (offset >= end) return { data: "", base, end, evicted: false };
      if (offset < base) return { data: this.replay(), base, end, evicted: true };
      let pos = base;
      let out = "";
      for (let i = this.head; i < this.chunks.length; i++) {
        const chunk = this.chunks[i];
        if (chunk == null) continue;
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
