'use strict';

/**
 * LineAssembler — consumes token arrays from AnsiTokenizer and produces
 * clean assembled lines, correctly interpreting CR-overwrite and cursor movement.
 *
 * Core improvement over the old split('\n') approach:
 *   "Loading...\rPrompt?" → "Prompt?"  (not "Loading...Prompt?")
 *
 * Token types handled:
 *   { type: 'text', content: '...' }   — append at cursor position
 *   { type: 'lf' }                      — flush current line to completed buffer
 *   { type: 'cr' }                      — reset cursor to column 0
 *   { type: 'csi', params, final: 'K' } — erase in line (from cursor to end)
 *   { type: 'csi', params, final: 'C' } — cursor forward N columns
 *   { type: 'csi', params, final: 'D' } — cursor back N columns
 *   All other CSI/OSC/control           — ignored
 */
class LineAssembler {
  constructor({ maxLineLength = 500 } = {}) {
    this._maxLineLength = maxLineLength;
    // Current line stored as an array of characters (sparse — gaps are spaces)
    // Using an array allows efficient overwrite at arbitrary cursor positions.
    this._line = [];
    // Cursor column position within the current line
    this._cursor = 0;
    // Logical end of line: the furthest position written since the last CR or line start.
    // Tracks how many characters are "visible" in the current line for detection purposes.
    this._logicalEnd = 0;
    // When true, the next write resets _logicalEnd to 0 first (deferred CR reset).
    // This allows CRLF (\r\n) to flush the pre-CR content correctly: if LF fires before
    // any post-CR write, _logicalEnd is unchanged so the line is preserved.
    this._pendingCrReset = false;
    // Completed lines waiting to be consumed
    this._completedLines = [];
  }

  /**
   * Feed an array of tokens into the assembler.
   * @param {Array} tokens — token objects from AnsiTokenizer.tokenize()
   */
  feed(tokens) {
    for (const token of tokens) {
      switch (token.type) {
        case 'text':
          this._writeText(token.content);
          break;
        case 'lf':
          this._flushLine();
          break;
        case 'cr':
          // Reset cursor to column 0. Mark that the next write should reset _logicalEnd
          // so old trailing chars are excluded. Using a deferred reset means that if LF
          // fires before any post-CR write (CRLF = Windows line endings), the pre-CR
          // content is preserved in the flushed line.
          this._cursor = 0;
          this._pendingCrReset = true;
          break;
        case 'csi':
          this._handleCsi(token);
          break;
        // 'osc', 'control', and anything else are ignored
      }
    }
  }

  /**
   * Returns and clears the completed lines buffer.
   * Each entry is the assembled string for that line.
   * @returns {string[]}
   */
  getCompletedLines() {
    const lines = this._completedLines;
    this._completedLines = [];
    return lines;
  }

  /**
   * Returns the current (incomplete) pending line, trimmed of leading/trailing
   * whitespace. Returns '' if there is no pending content.
   * @returns {string}
   */
  getPendingLine() {
    return this._buildLineString().trim();
  }

  /**
   * Returns the raw pending line without trimming, preserving leading whitespace.
   * Useful for indentation checks in Layer 3 filters.
   * @returns {string}
   */
  getRawPendingLine() {
    return this._buildLineString();
  }

  /**
   * Returns true if the pending line has any non-whitespace content.
   * @returns {boolean}
   */
  hasPendingContent() {
    const str = this._buildLineString();
    return /\S/.test(str);
  }

  /**
   * Clears all state — completed lines, current line, cursor, and logical end.
   */
  reset() {
    this._line = [];
    this._cursor = 0;
    this._logicalEnd = 0;
    this._pendingCrReset = false;
    this._completedLines = [];
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Write text content at the current cursor position, overwriting existing
   * characters. Respects the maxLineLength cap. Updates _logicalEnd to track
   * the furthest position written since the last CR.
   */
  _writeText(content) {
    if (content.length === 0) return;
    // Deferred CR reset: first write after a CR clears the logical end so old
    // trailing chars from before the CR are excluded from the built string.
    if (this._pendingCrReset) {
      this._logicalEnd = 0;
      this._pendingCrReset = false;
    }
    for (let i = 0; i < content.length; i++) {
      if (this._cursor >= this._maxLineLength) {
        break; // Hard cap — discard overflow
      }
      this._line[this._cursor] = content[i];
      this._cursor++;
      if (this._cursor > this._logicalEnd) {
        this._logicalEnd = this._cursor;
      }
    }
  }

  /**
   * Flush the current line to the completed buffer and reset for a new line.
   */
  _flushLine() {
    this._completedLines.push(this._buildLineString());
    this._line = [];
    this._cursor = 0;
    this._logicalEnd = 0;
    this._pendingCrReset = false;
  }

  /**
   * Build the current line as a string from the sparse character array,
   * up to _logicalEnd (the furthest position written since the last CR).
   * Gaps (undefined entries) are rendered as spaces.
   */
  _buildLineString() {
    if (this._logicalEnd === 0) return '';
    const chars = [];
    for (let i = 0; i < this._logicalEnd; i++) {
      chars.push(this._line[i] !== undefined ? this._line[i] : ' ');
    }
    return chars.join('');
  }

  /**
   * Handle CSI tokens. Only cursor movement (C/D) and erase in line (K)
   * affect content; everything else is ignored.
   */
  _handleCsi(token) {
    const { params, final } = token;
    switch (final) {
      case 'K': // Erase in line
        this._eraseInLine(params);
        break;
      case 'C': // Cursor forward
        this._moveCursor(+(params[0] || 1));
        break;
      case 'D': // Cursor back
        this._moveCursor(-(params[0] || 1));
        break;
      // All other CSI sequences (SGR, DEC private modes, etc.) — ignored
    }
  }

  /**
   * Erase in line (CSI Ps K):
   *   Ps = 0 (or absent) — erase from cursor to end of line
   *   Ps = 1             — erase from start to cursor
   *   Ps = 2             — erase entire line
   */
  _eraseInLine(params) {
    const mode = params[0] || 0;
    if (mode === 0) {
      // Erase from cursor to end: truncate logical end to cursor position
      this._line.splice(this._cursor);
      if (this._logicalEnd > this._cursor) {
        this._logicalEnd = this._cursor;
      }
    } else if (mode === 1) {
      // Erase from start to cursor (inclusive): replace with spaces
      for (let i = 0; i <= this._cursor && i < this._logicalEnd; i++) {
        this._line[i] = ' ';
      }
    } else if (mode === 2) {
      // Erase entire line — cursor position is NOT reset by erase-in-line
      this._line = [];
      this._logicalEnd = 0;
    }
  }

  /**
   * Move cursor by delta columns. Clamps to [0, maxLineLength].
   */
  _moveCursor(delta) {
    this._cursor = Math.max(0, Math.min(this._maxLineLength, this._cursor + delta));
  }
}

module.exports = { LineAssembler };
