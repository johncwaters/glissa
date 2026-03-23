'use strict';

// ANSI Tokenizer — stateful single-pass tokenizer for PTY output
// 5-state machine: GROUND, ESCAPE, CSI_ENTRY, OSC_STRING, CHARSET
//
// Token types:
//   { type: 'text', content: 'hello' }
//   { type: 'csi', params: [1, 33], final: 'm' }
//   { type: 'osc', content: '0;title' }
//   { type: 'cr' }
//   { type: 'lf' }
//   { type: 'control', code: 0x08 }
//
// Performance: uses index-based slicing throughout — no char-by-char concatenation.

const GROUND = 0;
const ESCAPE = 1;
const CSI_ENTRY = 2;
const OSC_STRING = 3;
const CHARSET = 4;

const MAX_PARTIAL = 256;

class AnsiTokenizer {
  constructor() {
    this._state = GROUND;
    // Partial escape sequence saved across chunk boundaries.
    // Always starts with \x1b and contains everything up to (but not including)
    // the byte that would complete the sequence.
    this._partial = '';
  }

  reset() {
    this._state = GROUND;
    this._partial = '';
  }

  // Returns array of token objects for the given string chunk.
  // State and partial buffer carry over between calls.
  tokenize(str) {
    if (str.length === 0) return [];

    // If we have a saved partial sequence from a previous chunk, prepend it and
    // re-parse from GROUND so the state machine sees the full \x1b-prefixed sequence.
    let input = str;
    if (this._partial.length > 0) {
      input = this._partial + str;
      this._partial = '';
      this._state = GROUND;
    }

    const tokens = [];
    const len = input.length;
    let i = 0;
    let textRunStart = -1; // start index of current printable-text run, -1 = none
    let escStart = -1;     // start index of current escape sequence (\x1b position)

    // Emit any open text run ending at position `end`
    const flushText = (end) => {
      if (textRunStart !== -1 && end > textRunStart) {
        tokens.push({ type: 'text', content: input.slice(textRunStart, end) });
        textRunStart = -1;
      }
    };

    while (i < len) {
      const ch = input[i];
      const code = input.charCodeAt(i);

      switch (this._state) {

        case GROUND: {
          if (ch === '\x1b') {
            flushText(i);
            escStart = i;
            this._state = ESCAPE;
            i++;
          } else if (ch === '\r') {
            flushText(i);
            tokens.push({ type: 'cr' });
            i++;
          } else if (ch === '\n') {
            flushText(i);
            tokens.push({ type: 'lf' });
            i++;
          } else if (code < 0x20 || code === 0x7f) {
            flushText(i);
            tokens.push({ type: 'control', code });
            i++;
          } else {
            if (textRunStart === -1) textRunStart = i;
            i++;
          }
          break;
        }

        case ESCAPE: {
          i++;
          if (ch === '[') {
            this._state = CSI_ENTRY;
          } else if (ch === ']') {
            this._state = OSC_STRING;
          } else if (ch === '(' || ch === ')' || ch === '/') {
            this._state = CHARSET;
          } else {
            // Unknown two-char escape — discard, return to GROUND
            escStart = -1;
            this._state = GROUND;
          }
          break;
        }

        case CSI_ENTRY: {
          // CSI final byte: 0x40–0x7E
          if (code >= 0x40 && code <= 0x7e) {
            // escStart points to \x1b, escStart+2 is first param byte, i is final byte
            const raw = input.slice(escStart + 2, i); // between \x1b[ and final
            const params = _parseCsiParams(raw);
            tokens.push({ type: 'csi', params, final: ch });
            escStart = -1;
            this._state = GROUND;
            i++;
          } else {
            // Still collecting param/intermediate bytes — check overflow
            if (i - escStart > MAX_PARTIAL) {
              // Pathological: abandon sequence, return to GROUND
              escStart = -1;
              this._state = GROUND;
            }
            i++;
          }
          break;
        }

        case OSC_STRING: {
          if (ch === '\x07') {
            // BEL terminator — content is between \x1b] and here
            const content = input.slice(escStart + 2, i);
            tokens.push({ type: 'osc', content });
            escStart = -1;
            this._state = GROUND;
            i++;
          } else if (ch === '\x1b') {
            // Possible ST (\x1b\)
            if (i + 1 < len && input[i + 1] === '\\') {
              const content = input.slice(escStart + 2, i);
              tokens.push({ type: 'osc', content });
              escStart = -1;
              this._state = GROUND;
              i += 2;
            } else if (i + 1 === len) {
              // End of chunk with dangling \x1b — save partial, will complete next chunk
              i++;
              // partial saved below after loop
            } else {
              // \x1b followed by non-\ — absorb into OSC content
              i++;
            }
            // Check overflow
            if (escStart !== -1 && i - escStart > MAX_PARTIAL) {
              escStart = -1;
              this._state = GROUND;
            }
          } else {
            i++;
            // Check overflow
            if (i - escStart > MAX_PARTIAL) {
              escStart = -1;
              this._state = GROUND;
            }
          }
          break;
        }

        case CHARSET: {
          // Consume exactly one designator byte then return to GROUND
          escStart = -1;
          this._state = GROUND;
          i++;
          break;
        }
      }
    }

    // End of input
    if (this._state === GROUND) {
      flushText(len);
    } else {
      // We're mid-sequence — save the partial for the next chunk.
      // escStart is the position in `input` where the sequence began.
      if (escStart !== -1) {
        this._partial = input.slice(escStart);
      } else {
        // Shouldn't happen, but safety: reset
        this._state = GROUND;
      }
    }

    return tokens;
  }
}

// Parse CSI parameter string into array of integers.
// "1;33" → [1, 33],  "" → [0],  ";" → [0, 0],  "?25" → [25]
// Strips everything except digits and semicolons (removes ?, >, <, =, spaces, etc.)
function _parseCsiParams(raw) {
  if (raw.length === 0) return [0];
  const paramStr = raw.replace(/[^0-9;]/g, '');
  if (paramStr.length === 0) return [0];
  return paramStr.split(';').map(p => (p === '' ? 0 : parseInt(p, 10)));
}

module.exports = { AnsiTokenizer };
