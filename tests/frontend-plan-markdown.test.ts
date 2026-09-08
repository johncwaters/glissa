import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlanMarkdown, planInlineText, splitPlanSections } from '../public/plan/plan-markdown-core.ts';

class FakeText {
  readonly textContent: string;

  constructor(textContent: string) {
    this.textContent = textContent;
  }
}

class FakeElement {
  readonly children: (FakeElement | FakeText)[] = [];
  className = '';
  href = '';
  id = '';
  rel = '';
  target = '';
  private ownText = '';

  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...children: (FakeElement | FakeText)[]) {
    this.children.push(...children);
  }

  querySelectorAll(selector: string) {
    return descendants(this).filter((node) => node.tagName === selector);
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(text: string) {
    this.ownText = text;
    this.children.length = 0;
  }
}

function descendants(root: FakeElement): FakeElement[] {
  const nested = root.children.filter((child): child is FakeElement => child instanceof FakeElement);
  return [root, ...nested.flatMap(descendants)];
}

test('plan markdown parses the M1 block tree and stable sections', () => {
  const markdown = [
    'Preamble with `code` and *emphasis*.',
    '',
    '# Build',
    '',
    '- first',
    '  - nested',
    '1. ordered',
    '',
    '```ts',
    'const value = 1;',
    '```',
    '',
    '| Name | State |',
    '| --- | --- |',
    '| Plan | ready |',
    '',
    '> quoted **strongly**',
    '',
    '---',
    '',
    '# Build',
  ].join('\n');
  const blocks = parsePlanMarkdown(markdown);
  assert.deepEqual(blocks.map((block) => block.type), [
    'paragraph', 'heading', 'list', 'list', 'code', 'table', 'blockquote', 'rule', 'heading',
  ]);
  const headings = blocks.filter((block) => block.type === 'heading');
  assert.deepEqual(headings.map((heading) => heading.id), ['plan-h-build', 'plan-h-build-2']);
  const unordered = blocks.find((block) => block.type === 'list' && !block.ordered);
  assert.equal(unordered?.type, 'list');
  if (unordered?.type !== 'list') throw new Error('Expected an unordered list');
  assert.equal(unordered.items[0].children[1]?.type, 'list');
  const code = blocks.find((block) => block.type === 'code');
  assert.equal(code?.language, 'ts');
});

test('plan rendering keeps safe links and leaves unsafe URLs and raw HTML as text', async () => {
  const fakeDocument = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeText(text),
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
  const { renderPlanBlocks } = await import('../public/plan/plan-render.ts');
  const markdown = [
    '[web](https://example.com/path) [plain](http://example.org)',
    '[script](javascript:alert(1)) [payload](data:text/html;base64,abc)',
    '<script>alert(1)</script>',
  ].join('\n\n');
  const root = renderPlanBlocks(parsePlanMarkdown(markdown));
  const links = Array.from(root.querySelectorAll('a'));
  assert.deepEqual(links.map((link) => link.href), ['https://example.com/path', 'http://example.org/']);
  assert.deepEqual(links.map((link) => [link.target, link.rel]), [
    ['_blank', 'noopener noreferrer'],
    ['_blank', 'noopener noreferrer'],
  ]);
  assert.match(root.textContent, /script payload/);
  assert.match(root.textContent, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(root.textContent, /javascript:|data:text/);
});

test('a plan paragraph of unclosed link brackets parses in linear time', () => {
  const unclosedBrackets = '[word '.repeat(Math.ceil((40 * 1024) / 6));
  const startedAt = Date.now();
  const blocks = parsePlanMarkdown(unclosedBrackets);
  assert.equal(blocks.length, 1);
  assert.ok(Date.now() - startedAt < 500, 'a 40 KB bracket run stays well under a second');
});

test('a heading line of spaces, hashes and spaces parses in linear time', () => {
  const runLength = 34 * 1024;
  const adversarial = `# ${' '.repeat(runLength)}${'#'.repeat(runLength)}${' '.repeat(runLength)}x`;
  assert.ok(adversarial.length > 100 * 1024, 'the crafted heading line is over 100 KB');
  const startedAt = Date.now();
  const blocks = parsePlanMarkdown(adversarial);
  assert.ok(Date.now() - startedAt < 50, 'a 100 KB heading line never backtracks');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'paragraph');
});

test('a closing hash run is stripped from a heading only when a space precedes it', () => {
  const blocks = parsePlanMarkdown('## Ship it ###\n\n## Ship###\n\n### ###');
  const headings = blocks.filter((block) => block.type === 'heading');
  assert.deepEqual(headings.map((heading) => heading.level), [2, 2, 3]);
  assert.deepEqual(headings.map((heading) => planInlineText(heading.children)), ['Ship it', 'Ship###', '###']);
});

test('blockquote and list nesting is capped instead of recursing without bound', () => {
  const quoteBlocks = parsePlanMarkdown('>'.repeat(8000));
  assert.equal(quoteBlocks.length, 1);
  assert.equal(quoteBlocks[0].type, 'blockquote');

  const indented = Array.from({ length: 6000 }, (_, step) => `${' '.repeat(step)}- item ${step}`).join('\n');
  const listBlocks = parsePlanMarkdown(indented);
  assert.ok(listBlocks.length > 0);
  assert.ok(listBlocks.every((block) => block.type === 'list'), 'every deeper marker still parses as a list');
});

test('a link target keeps one level of nested parentheses and stops at the outer close', () => {
  const blocks = parsePlanMarkdown('[wiki](https://example.com/a_(b)_c) tail');
  assert.equal(blocks[0].type, 'paragraph');
  if (blocks[0].type !== 'paragraph') throw new Error('Expected a paragraph');
  const link = blocks[0].children.find((node) => node.type === 'link');
  assert.equal(link?.type, 'link');
  if (link?.type !== 'link') throw new Error('Expected a link');
  assert.equal(link.href, 'https://example.com/a_(b)_c');
  assert.equal(blocks[0].children.at(-1)?.type, 'text');
});

test('a fenced code info string renders at most one safe language class', async () => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag: string) => new FakeElement(tag),
      createTextNode: (text: string) => new FakeText(text),
    },
  });
  const { renderPlanBlocks } = await import('../public/plan/plan-render.ts');
  const markdown = [
    '```js dialog-overlay',
    'alert(1)',
    '```',
    '',
    '```plan face" onclick="x',
    'body',
    '```',
    '',
    '```<script>',
    'body',
    '```',
  ].join('\n');
  const blocks = parsePlanMarkdown(markdown);
  const codeBlocks = blocks.filter((block) => block.type === 'code');
  assert.deepEqual(codeBlocks.map((block) => block.type === 'code' && block.language), ['js', 'plan', '']);
  const root = renderPlanBlocks(blocks);
  const codeClasses = Array.from(root.querySelectorAll('code')).map((node) => node.className);
  assert.deepEqual(codeClasses, ['language-js', 'language-plan', '']);
});

test('a heading id is namespaced so plan text cannot claim a dashboard element id', () => {
  const blocks = parsePlanMarkdown('# notice-region\n\n## Session Card\n');
  const headings = blocks.filter((block) => block.type === 'heading');
  assert.deepEqual(headings.map((heading) => heading.id), ['plan-h-notice-region', 'plan-h-session-card']);
  assert.equal(headings.every((heading) => heading.id.startsWith('plan-h-')), true);
});

test('a table divider is recognized in linear time, whatever padding and alignment it carries', () => {
  const table = ['| a | b |', '| :--- | ---: |', '| 1 | 2 |'].join('\n');
  assert.equal(parsePlanMarkdown(table)[0]?.type, 'table');
  assert.equal(parsePlanMarkdown(['a | b', '--- | ---', '1 | 2'].join('\n'))[0]?.type, 'table');
  assert.equal(parsePlanMarkdown(['| a |', '| --- |', '| 1 |'].join('\n'))[0]?.type, 'paragraph');

  const adversarial = `| a |\n${'|'.repeat(40)}${' '.repeat(40)}x\n`;
  const startedAt = process.hrtime.bigint();
  parsePlanMarkdown(adversarial);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 200, `a divider-shaped line must not backtrack, took ${elapsedMs} ms`);
});

test('every heading opens a section, and what stands before the first one is the preamble', () => {
  const sections = splitPlanSections(parsePlanMarkdown([
    'A sentence before any heading.',
    '',
    '# Ship it',
    '',
    'the shipping story',
    '',
    '## Rollout',
    '',
    'stage it',
  ].join('\n')));

  assert.deepEqual(sections.map((section) => [section.heading, section.level, section.blocks.length]), [
    [null, 0, 1],
    ['Ship it', 1, 2],
    ['Rollout', 2, 2],
  ]);
  assert.equal(sections[0].id, null, 'the preamble hangs under no heading');
  assert.equal(sections[1].blocks[0].type, 'heading', 'a section carries the heading it opens');
  assert.equal(sections[1].id, sections[1].blocks[0].type === 'heading' ? sections[1].blocks[0].id : null);
});

test('a plan with no headings is one whole-plan section, and an empty plan has none', () => {
  const single = splitPlanSections(parsePlanMarkdown('just a paragraph\n\nand another'));
  assert.deepEqual(single.map((section) => section.heading), [null]);
  assert.equal(single[0].blocks.length, 2);
  assert.deepEqual(splitPlanSections(parsePlanMarkdown('')), []);
  assert.deepEqual(splitPlanSections(parsePlanMarkdown('\n\n   \n')), []);
});

test('a plan that opens on its heading has no preamble section', () => {
  const sections = splitPlanSections(parsePlanMarkdown('# Ship it\n\nbody'));
  assert.deepEqual(sections.map((section) => section.heading), ['Ship it']);
});

test('the section heading is the heading text a comment quotes back, never its markup', () => {
  const sections = splitPlanSections(parsePlanMarkdown('## Ship `now`, not **later**\n\nbody'));
  assert.equal(sections[0].heading, 'Ship now, not later');
});
