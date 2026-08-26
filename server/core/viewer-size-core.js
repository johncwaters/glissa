// Pure arbitration for the ONE PTY size a session's several data-WS viewers disagree about.
//
// A session owns one PTY but any number of data connections (a desktop tab, a second tab, a paired
// phone). Resize is last-write-wins among the viewers that are actually LOOKING at the terminal, which
// is correct while they all are: the newest arrival reflows the PTY and everyone sees the same grid.
// It breaks when a viewer STOPS looking (the phone leaves the Terminal screen, or a card is released
// back to its hidden home slot) without its box changing: the client caches its last sent size and
// never re-pushes, so a desktop left at ~40 cols by a phone stays there forever. The departing viewer
// therefore hands the size back, and the most recent surviving viewer's size is re-applied.

const MIN_COLS = 1;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 200;

function isApplicableViewerSize(cols, rows) {
  return Number.isInteger(cols) && Number.isInteger(rows)
    && cols >= MIN_COLS && cols <= MAX_COLS
    && rows >= MIN_ROWS && rows <= MAX_ROWS;
}

// `viewers` is any iterable of [key, { cols, rows, resizeSeq }] entries (a Map iterates as one).
// Recency is a monotonic sequence rather than a clock because two clients resizing in the same
// millisecond is ordinary, and a tie would silently hand the PTY to whichever entry iterated first.
// Entries with no recorded size have never declared themselves a viewer and are skipped, as is
// `departingKey` whether or not the caller has already dropped it. Returns the surviving viewer size
// to re-apply, or null when nobody is left to speak for the PTY (leave it as it is).
function pickSizeAfterDeparture(viewers, departingKey) {
  /** @type {{ cols: number, rows: number, resizeSeq: number }|null} */
  let winner = null;
  for (const [key, record] of viewers) {
    if (key === departingKey) continue;
    if (!record) continue;
    if (!isApplicableViewerSize(record.cols, record.rows)) continue;
    if (winner && record.resizeSeq <= winner.resizeSeq) continue;
    winner = record;
  }
  if (!winner) return null;
  return { cols: winner.cols, rows: winner.rows };
}

module.exports = { isApplicableViewerSize, pickSizeAfterDeparture };
