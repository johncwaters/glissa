// Client-side link handling for the session terminal. Without this, a URL in
// Claude's output is dead text in xterm: taps and clicks land nowhere on the
// viewing device, and only the Claude process on the SERVER machine can open
// anything (which is exactly the wrong browser for a paired phone). Two seams:
//
// - registerUrlLinkProvider: linkifies plain-text http(s) URLs (the common case
//   in Claude chat output) and opens them on the device that tapped.
// - osc8LinkHandler: activation for explicit OSC 8 hyperlinks; xterm itself
//   filters non-http(s) schemes because allowNonHttpProtocols stays false.
//
// URL detection is pure (link-detect-core.mjs); this shell only walks the
// xterm buffer and maps string offsets back to cells.

import { findUrls } from './link-detect-core.mjs';

// Bound the wrapped-line walk so pathological output (one endless logical
// line) cannot make every hover scan the whole scrollback.
const MAX_WRAPPED_ROWS = 50;

function openOnThisDevice(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function osc8LinkHandler() {
  return {
    activate(_event, uri) {
      openOnThisDevice(uri);
    },
    allowNonHttpProtocols: false,
  };
}

// Assemble the logical (unwrapped) line containing 1-based bufferLineNumber as
// one string, with a per-character map back to buffer cells so a URL spanning
// wrapped rows highlights and activates as one link.
function collectLogicalLine(buffer, bufferLineNumber) {
  let startIdx = bufferLineNumber - 1;
  while (startIdx > 0 && buffer.getLine(startIdx)?.isWrapped && bufferLineNumber - 1 - startIdx < MAX_WRAPPED_ROWS) {
    startIdx--;
  }
  let endIdx = bufferLineNumber - 1;
  while (buffer.getLine(endIdx + 1)?.isWrapped && endIdx - (bufferLineNumber - 1) < MAX_WRAPPED_ROWS) {
    endIdx++;
  }

  let text = '';
  const cellAt = []; // string index -> { x, y } (1-based buffer coords)
  for (let y = startIdx; y <= endIdx; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      if (cell.getWidth() === 0) continue; // trailing half of a wide glyph
      const chars = cell.getChars() || ' ';
      for (let k = 0; k < chars.length; k++) {
        text += chars[k];
        cellAt.push({ x: x + 1, y: y + 1 });
      }
    }
  }
  return { text, cellAt };
}

export function registerUrlLinkProvider(term) {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer?.active;
      if (!buffer) return callback(undefined);
      const { text, cellAt } = collectLogicalLine(buffer, bufferLineNumber);
      const links = findUrls(text).map(({ start, end, url }) => ({
        range: { start: cellAt[start], end: cellAt[end - 1] },
        text: url,
        activate(_event, matched) {
          openOnThisDevice(matched);
        },
      }));
      callback(links.length ? links : undefined);
    },
  });
}
