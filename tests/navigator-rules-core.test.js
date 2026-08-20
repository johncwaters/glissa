'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sweepMarkdown } = require('../server/core/navigator-rules-core');

function byCode(diagnostics, code) {
  return diagnostics.filter((diagnostic) => diagnostic.code === code);
}

test('sweepMarkdown reports repeated second word with an exact range', () => {
  const diagnostics = sweepMarkdown('This is the The point.');
  const repeated = byCode(diagnostics, 'repeated-word');
  assert.equal(repeated.length, 1);
  assert.deepEqual(repeated[0].range, {
    start: { line: 0, character: 12 },
    end: { line: 0, character: 15 },
  });
  assert.equal(repeated[0].severity, 2);
  assert.equal(repeated[0].source, 'glissa-navigator');
});

test('sweepMarkdown skips repeated words in inline code spans', () => {
  const diagnostics = sweepMarkdown('Keep `the the` code but flag the the prose.');
  const repeated = byCode(diagnostics, 'repeated-word');
  assert.equal(repeated.length, 1);
  assert.deepEqual(repeated[0].range, {
    start: { line: 0, character: 33 },
    end: { line: 0, character: 36 },
  });
});

test('sweepMarkdown skips repeated words and headings inside fenced code', () => {
  const text = ['# Title', '```', 'the the', '### Not a skip', '```', 'the the'].join('\n');
  const diagnostics = sweepMarkdown(text);
  assert.equal(byCode(diagnostics, 'heading-skip').length, 0);
  assert.deepEqual(byCode(diagnostics, 'repeated-word').map((diagnostic) => diagnostic.range.start.line), [5]);
});

test('sweepMarkdown reports an unclosed fence on the last fence marker', () => {
  const diagnostics = sweepMarkdown(['intro', '  ```js', 'code'].join('\n'));
  const unclosed = byCode(diagnostics, 'unclosed-fence');
  assert.equal(unclosed.length, 1);
  assert.deepEqual(unclosed[0].range, {
    start: { line: 1, character: 2 },
    end: { line: 1, character: 5 },
  });
});

test('sweepMarkdown does not report closed fences', () => {
  const diagnostics = sweepMarkdown(['```', 'code', '```'].join('\n'));
  assert.equal(byCode(diagnostics, 'unclosed-fence').length, 0);
});

test('sweepMarkdown reports heading jumps on the offending marker', () => {
  const diagnostics = sweepMarkdown(['# One', '### Three', '## Two', '#### Four'].join('\n'));
  const skips = byCode(diagnostics, 'heading-skip');
  assert.equal(skips.length, 2);
  assert.deepEqual(skips.map((diagnostic) => diagnostic.range), [
    { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
    { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } },
  ]);
});

test('sweepMarkdown accepts sequential heading levels', () => {
  const diagnostics = sweepMarkdown(['# One', '## Two', '### Three', '## Back'].join('\n'));
  assert.equal(byCode(diagnostics, 'heading-skip').length, 0);
});

test('sweepMarkdown ignores Setext headings and clean prose', () => {
  const diagnostics = sweepMarkdown(['Title', '=====', 'This is clean prose.'].join('\n'));
  assert.deepEqual(diagnostics, []);
});
