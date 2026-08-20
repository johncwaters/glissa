'use strict';

const WARNING = 2;
const SOURCE = 'glissa-navigator';
const FENCE_RE = /^(\s*)```/;
const HEADING_RE = /^( {0,3})(#{1,6})(?:\s|$)/;
const WORD_RE = /[A-Za-z][A-Za-z0-9']*/g;

function sweepMarkdown(text) {
  const diagnostics = [];
  const lines = splitLines(text);
  let isInFence = false;
  let lastFence = null;
  let previousHeadingLevel = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      lastFence = { line: lineIndex, character: fenceMatch[1].length };
      isInFence = !isInFence;
      continue;
    }

    if (isInFence) continue;

    addRepeatedWordDiagnostics(diagnostics, line, lineIndex);

    const headingMatch = line.match(HEADING_RE);
    if (!headingMatch) continue;

    const level = headingMatch[2].length;
    if (previousHeadingLevel > 0 && level > previousHeadingLevel + 1) {
      diagnostics.push(diagnostic(
        lineIndex,
        headingMatch[1].length,
        lineIndex,
        headingMatch[1].length + level,
        'heading-skip',
        `Heading jumps from level ${previousHeadingLevel} to ${level}`,
      ));
    }
    previousHeadingLevel = level;
  }

  if (isInFence && lastFence) {
    diagnostics.push(diagnostic(
      lastFence.line,
      lastFence.character,
      lastFence.line,
      lastFence.character + 3,
      'unclosed-fence',
      'Fence is not closed',
    ));
  }

  return diagnostics;
}

function splitLines(text) {
  return String(text).split(/\r?\n/);
}

function addRepeatedWordDiagnostics(diagnostics, line, lineIndex) {
  const inlineCodeMask = maskInlineCode(line);
  let previousWord = null;

  WORD_RE.lastIndex = 0;
  while (true) {
    const match = WORD_RE.exec(line);
    if (!match) break;

    const word = match[0];
    const start = match.index;
    const end = start + word.length;
    if (isMasked(inlineCodeMask, start, end)) {
      previousWord = null;
      continue;
    }

    const normalizedWord = word.toLowerCase();
    if (previousWord && previousWord.normalizedWord === normalizedWord) {
      diagnostics.push(diagnostic(
        lineIndex,
        start,
        lineIndex,
        end,
        'repeated-word',
        `Repeated word "${word}"`,
      ));
    }
    previousWord = { normalizedWord };
  }
}

function maskInlineCode(line) {
  const mask = new Array(line.length).fill(false);
  let spanStart = null;
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== '`') continue;
    if (spanStart === null) {
      spanStart = index;
      continue;
    }
    for (let spanIndex = spanStart; spanIndex <= index; spanIndex++) {
      mask[spanIndex] = true;
    }
    spanStart = null;
  }
  return mask;
}

function isMasked(mask, start, end) {
  for (let index = start; index < end; index++) {
    if (mask[index]) return true;
  }
  return false;
}

function diagnostic(startLine, startCharacter, endLine, endCharacter, code, message) {
  return {
    range: {
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    },
    severity: WARNING,
    source: SOURCE,
    code,
    message,
  };
}

module.exports = { sweepMarkdown };
