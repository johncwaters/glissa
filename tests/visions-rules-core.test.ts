import test from 'node:test';
import assert from 'node:assert/strict';

import type { SweepDiagnostic } from '../server/core/visions-rules-core.ts';
import { sweepMarkdown } from '../server/core/visions-rules-core.ts';

function byCode(diagnostics: SweepDiagnostic[], code: string) {
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
  assert.equal(repeated[0].source, 'glissa-visions');
});

test('a word inside a token that starts with a digit is not a word', () => {
  const line = 'Work kept off Codex by rule 1, or after a 1a fallback: opus is the default tier.';
  assert.deepEqual(sweepMarkdown(line).map((diagnostic) => diagnostic.message), []);
  assert.deepEqual(sweepMarkdown('the 3rd item and the 4th').map((diagnostic) => diagnostic.message), []);
  assert.deepEqual(sweepMarkdown('a real a a repeat').map((diagnostic) => diagnostic.message), ['Repeated word "a"']);
});

test('a word repeated across punctuation is not a repeat', () => {
  const cases = [
    'give it. It can also run.',
    'But wait! It can do more! It can.',
    '* [posthog.com repo](https://github.com/PostHog/posthog.com)',
    'see [main](main.md) and https://example.com/docs/docs',
    'read the [the guide](guide.md)',
    'the (the) aside',
  ];
  for (const line of cases) assert.deepEqual(sweepMarkdown(line).map((diagnostic) => diagnostic.message), [], line);
  assert.deepEqual(sweepMarkdown('tab\tseparated the\tthe word').map((diagnostic) => diagnostic.message), ['Repeated word "the"']);
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
