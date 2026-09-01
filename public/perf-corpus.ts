// Deterministic SGR/cursor-dense ANSI corpus for perf measurement.
//
// Pure, dependency-free, no DOM. `.mjs` so it is ESM in BOTH the browser (Vite
// imports it from perf-harness.js) and Node (tests dynamic-import it): the
// project is type:commonjs, so a plain `.js` with `export` would be treated as
// CJS by Node and fail to load. Dense escape content (colors, dim, cursor
// moves) so the xterm parser does realistic work, not trivial ASCII.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FG = [31, 32, 33, 34, 35, 36, 90, 91, 92, 93, 94, 95, 96, 97];
const WORDS = [
  'init', 'loading', 'module', 'resolve', 'compile', 'render', 'commit',
  'flush', 'parse', 'token', 'frame', 'buffer', 'socket', 'stream', 'chunk', 'queue',
];

// One SGR/cursor-dense line, CRLF-terminated.
function buildLine(rnd: () => number) {
  const segs = 3 + Math.floor(rnd() * 6);
  let s = '';
  for (let i = 0; i < segs; i++) {
    const fg = FG[Math.floor(rnd() * FG.length)];
    const bold = rnd() < 0.3 ? '1;' : '';
    const word = WORDS[Math.floor(rnd() * WORDS.length)];
    const n = Math.floor(rnd() * 10000);
    s += `\x1b[${bold}${fg}m${word}\x1b[0m \x1b[2m${n}\x1b[0m `;
  }
  // A cursor column move + a short redraw fragment to exercise parser state.
  s += `\x1b[${1 + Math.floor(rnd() * 40)}G`;
  return `${s}\r\n`;
}

// `lines` of dense corpus as one string. Deterministic for a given seed.
export function generateCorpus(lines = 200, seed = 1) {
  const rnd = mulberry32(seed);
  let out = '';
  for (let i = 0; i < lines; i++) out += buildLine(rnd);
  return out;
}
