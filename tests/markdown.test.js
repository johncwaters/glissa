'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const md = require('../teamlib/markdown');

test('escapeRegExp escapes regex metacharacters', () => {
  const re = new RegExp(`^${md.escapeRegExp('a.b*c?')}$`);
  assert.equal(re.test('a.b*c?'), true);
  assert.equal(re.test('axbycz'), false);
});

test('hasHeading matches an ATX heading of any level, case-insensitively', () => {
  assert.equal(md.hasHeading('## Topic\nsome text', 'Topic'), true);
  assert.equal(md.hasHeading('### topic\nsome text', 'Topic'), true);
  assert.equal(md.hasHeading('no heading here', 'Topic'), false);
  assert.equal(md.hasHeading('## Topics\nnot the same heading', 'Topic'), false);
});

test('sectionFirstLine returns the first non-empty content line under a heading', () => {
  const text = '## Topic\n\n- Boondocking basics\n- second line\n## Next\nother';
  assert.equal(md.sectionFirstLine(text, 'Topic'), 'Boondocking basics');
  assert.equal(md.sectionFirstLine(text, 'Missing'), '');
  assert.equal(md.sectionFirstLine('', 'Topic'), '');
});

test('sectionFirstLine skips blank lines and heading lines to find the first content line', () => {
  const text = '## Topic\n\n\n## Next\ncontent';
  assert.equal(md.sectionFirstLine(text, 'Topic'), 'content');
});

test('readParagraph joins the paragraph directly under a heading', () => {
  const text = '## Summary\nLine one\nLine two\n\n## Next\nignored';
  assert.equal(md.readParagraph(text, 'Summary'), 'Line one Line two');
});

test('readParagraph stops at the next heading or a blank line after content started', () => {
  const withHeading = '## Summary\nLine one\n## Next\nignored';
  assert.equal(md.readParagraph(withHeading, 'Summary'), 'Line one');
  const withBlank = '## Summary\nLine one\n\nLine two (separate paragraph)';
  assert.equal(md.readParagraph(withBlank, 'Summary'), 'Line one');
  assert.equal(md.readParagraph('', 'Summary'), '');
  assert.equal(md.readParagraph('## Other\ntext', 'Summary'), '');
});

test('readParagraph strips a leading list marker from each line', () => {
  const text = '## Notes\n- first\n- second';
  assert.equal(md.readParagraph(text, 'Notes'), 'first second');
});
