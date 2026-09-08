export type PlanInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'emphasis'; children: PlanInline[] }
  | { type: 'strong'; children: PlanInline[] }
  | { type: 'link'; href: string; children: PlanInline[] };

export interface PlanListItem {
  children: PlanBlock[];
}

export type PlanBlock =
  | { type: 'heading'; level: number; id: string; children: PlanInline[] }
  | { type: 'paragraph'; children: PlanInline[] }
  | { type: 'list'; ordered: boolean; items: PlanListItem[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'table'; header: PlanInline[][]; rows: PlanInline[][][] }
  | { type: 'blockquote'; blocks: PlanBlock[] }
  | { type: 'rule' };

interface ParseContext {
  slugCounts: Map<string, number>;
}

interface ListLine {
  indent: number;
  ordered: boolean;
  content: string;
}

interface PlanLinkSpan {
  label: string;
  target: string;
  end: number;
}

interface PlanHeadingLine {
  level: number;
  text: string;
}

const MAX_LINK_TARGET_PAREN_DEPTH = 2;
const MAX_BLOCK_NESTING_DEPTH = 8;
const HEADING_SCAN_MAX_CHARS = 4096;

const headingPattern = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const fencePattern = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;
const listPattern = /^(\s*)(?:([-+*])|(\d+)[.)])\s+(.+)$/;
const rulePattern = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const tableDividerCellPattern = /^:?-{3,}:?$/;
const fenceLanguagePattern = /^[A-Za-z0-9_+#.-]{1,32}$/;

function withoutClosingHeadingMarks(text: string): string {
  const trimmed = text.trimEnd();
  let textEnd = trimmed.length;
  while (textEnd > 0 && trimmed[textEnd - 1] === '#') textEnd--;
  if (textEnd === trimmed.length || textEnd === 0) return trimmed;
  const charBeforeMarks = trimmed[textEnd - 1];
  if (charBeforeMarks !== ' ' && charBeforeMarks !== '\t') return trimmed;
  return trimmed.slice(0, textEnd).trimEnd();
}

function headingLine(line: string): PlanHeadingLine | null {
  if (line.length > HEADING_SCAN_MAX_CHARS) return null;
  const heading = headingPattern.exec(line);
  if (!heading) return null;
  return { level: heading[1].length, text: withoutClosingHeadingMarks(heading[2]) };
}

function fenceLanguage(infoString: string): string {
  const firstToken = infoString.trim().split(/\s+/)[0] ?? '';
  return fenceLanguagePattern.test(firstToken) ? firstToken : '';
}

function appendText(nodes: PlanInline[], text: string) {
  if (!text) return;
  const last = nodes.at(-1);
  if (last?.type === 'text') {
    last.text += text;
    return;
  }
  nodes.push({ type: 'text', text });
}

function strongMarkerAt(source: string, cursor: number): string | null {
  if (source.startsWith('**', cursor)) return '**';
  if (source.startsWith('__', cursor)) return '__';
  return null;
}

function emphasisMarkerAt(source: string, cursor: number): string | null {
  if (source.startsWith('*', cursor)) return '*';
  if (source.startsWith('_', cursor)) return '_';
  return null;
}

function safeHttpHref(href: string): string | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    return null;
  } catch {
    return null;
  }
}

function findClosingMarker(source: string, marker: string, from: number) {
  const index = source.indexOf(marker, from);
  return index > from ? index : -1;
}

function firstIndexFinder(source: string, needle: string) {
  let firstKnownIndex = source.indexOf(needle);
  return function firstIndexAtOrAfter(from: number): number {
    if (firstKnownIndex === -1) return -1;
    if (firstKnownIndex >= from) return firstKnownIndex;
    firstKnownIndex = source.indexOf(needle, from);
    return firstKnownIndex;
  };
}

function linkTargetEnd(source: string, start: number): number {
  let openParenDepth = 1;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === '(') openParenDepth++;
    if (char === ')') openParenDepth--;
    if (openParenDepth === 0) return index;
    if (openParenDepth > MAX_LINK_TARGET_PAREN_DEPTH) return -1;
  }
  return -1;
}

function planLinkAt(
  source: string,
  cursor: number,
  closeBracketAtOrAfter: (from: number) => number,
): PlanLinkSpan | null {
  if (source[cursor] !== '[') return null;
  const labelEnd = closeBracketAtOrAfter(cursor + 1);
  if (labelEnd <= cursor + 1) return null;
  if (source[labelEnd + 1] !== '(') return null;
  const targetEnd = linkTargetEnd(source, labelEnd + 2);
  if (targetEnd === -1) return null;
  return {
    label: source.slice(cursor + 1, labelEnd),
    target: source.slice(labelEnd + 2, targetEnd),
    end: targetEnd + 1,
  };
}

function parsePlanInline(source: string): PlanInline[] {
  const nodes: PlanInline[] = [];
  const closeBracketAtOrAfter = firstIndexFinder(source, ']');
  let cursor = 0;
  while (cursor < source.length) {
    const link = planLinkAt(source, cursor, closeBracketAtOrAfter);
    if (link) {
      const href = safeHttpHref(link.target.trim());
      if (href) nodes.push({ type: 'link', href, children: parsePlanInline(link.label) });
      if (!href) appendText(nodes, link.label);
      cursor = link.end;
      continue;
    }

    if (source.startsWith('`', cursor)) {
      const closing = findClosingMarker(source, '`', cursor + 1);
      if (closing !== -1) {
        nodes.push({ type: 'code', text: source.slice(cursor + 1, closing) });
        cursor = closing + 1;
        continue;
      }
    }

    const strongMarker = strongMarkerAt(source, cursor);
    if (strongMarker) {
      const closing = findClosingMarker(source, strongMarker, cursor + strongMarker.length);
      if (closing !== -1) {
        nodes.push({
          type: 'strong',
          children: parsePlanInline(source.slice(cursor + strongMarker.length, closing)),
        });
        cursor = closing + strongMarker.length;
        continue;
      }
    }

    const emphasisMarker = emphasisMarkerAt(source, cursor);
    if (emphasisMarker) {
      const closing = findClosingMarker(source, emphasisMarker, cursor + 1);
      if (closing !== -1) {
        nodes.push({ type: 'emphasis', children: parsePlanInline(source.slice(cursor + 1, closing)) });
        cursor = closing + 1;
        continue;
      }
    }

    appendText(nodes, source[cursor]);
    cursor++;
  }
  return nodes;
}

export function planInlineText(nodes: readonly PlanInline[]): string {
  return nodes.map((node) => {
    if (node.type === 'text' || node.type === 'code') return node.text;
    return planInlineText(node.children);
  }).join('');
}

const HEADING_ID_PREFIX = 'plan-h-';

function slugFor(text: string, context: ParseContext) {
  const base = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  const count = (context.slugCounts.get(base) ?? 0) + 1;
  context.slugCounts.set(base, count);
  const uniqueBase = count === 1 ? base : `${base}-${count}`;
  return `${HEADING_ID_PREFIX}${uniqueBase}`;
}

function isTableDivider(line: string | undefined): boolean {
  if (typeof line !== 'string' || !line.includes('|')) return false;
  const cells = splitTableRow(line);
  if (cells.length < 2) return false;
  return cells.every((cell) => tableDividerCellPattern.test(cell));
}

function splitTableRow(line: string) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function listLine(line: string): ListLine | null {
  const match = listPattern.exec(line);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/g, '    ').length,
    ordered: !!match[3],
    content: match[4],
  };
}

function parseList(lines: readonly string[], start: number, context: ParseContext, depth: number) {
  const first = listLine(lines[start]);
  if (!first) return null;
  const items: PlanListItem[] = [];
  const ordered = first.ordered;
  const baseIndent = first.indent;
  let index = start;

  while (index < lines.length) {
    const current = listLine(lines[index]);
    if (!current || current.indent < baseIndent) break;
    if (current.indent > baseIndent) {
      if (depth >= MAX_BLOCK_NESTING_DEPTH) break;
      const nested = parseList(lines, index, context, depth + 1);
      if (!nested || items.length === 0) break;
      items.at(-1)?.children.push(nested.block);
      index = nested.next;
      continue;
    }
    if (current.ordered !== ordered) break;
    items.push({ children: [{ type: 'paragraph', children: parsePlanInline(current.content) }] });
    index++;
  }

  return { block: { type: 'list', ordered, items } satisfies PlanBlock, next: index };
}

function isBlockStart(lines: readonly string[], index: number) {
  const line = lines[index] ?? '';
  if (line.trim() === '') return true;
  if (headingLine(line) || fencePattern.test(line) || rulePattern.test(line)) return true;
  if (listLine(line) || /^ {0,3}>/.test(line)) return true;
  return index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1]);
}

function parseBlocks(lines: readonly string[], context: ParseContext, depth: number): PlanBlock[] {
  const blocks: PlanBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index++;
      continue;
    }

    const fence = fencePattern.exec(line);
    if (fence) {
      const body: string[] = [];
      const fenceMarker = fence[1][0];
      const fenceLength = fence[1].length;
      index++;
      while (index < lines.length) {
        const closingFence = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[index]);
        if (closingFence && closingFence[1][0] === fenceMarker && closingFence[1].length >= fenceLength) break;
        body.push(lines[index]);
        index++;
      }
      if (index < lines.length) index++;
      blocks.push({ type: 'code', language: fenceLanguage(fence[2]), text: body.join('\n') });
      continue;
    }

    const heading = headingLine(line);
    if (heading) {
      const children = parsePlanInline(heading.text);
      blocks.push({ type: 'heading', level: heading.level, id: slugFor(planInlineText(children), context), children });
      index++;
      continue;
    }

    if (rulePattern.test(line)) {
      blocks.push({ type: 'rule' });
      index++;
      continue;
    }

    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
      const header = splitTableRow(line).map(parsePlanInline);
      const rows: PlanInline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(splitTableRow(lines[index]).map(parsePlanInline));
        index++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    const parsedList = parseList(lines, index, context, depth);
    if (parsedList) {
      blocks.push(parsedList.block);
      index = parsedList.next;
      continue;
    }

    if (depth < MAX_BLOCK_NESTING_DEPTH && /^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^ {0,3}> ?/, ''));
        index++;
      }
      blocks.push({ type: 'blockquote', blocks: parseBlocks(quoteLines, context, depth + 1) });
      continue;
    }

    const paragraphLines = [line.trim()];
    index++;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index++;
    }
    blocks.push({ type: 'paragraph', children: parsePlanInline(paragraphLines.join(' ')) });
  }
  return blocks;
}

export function parsePlanMarkdown(markdown: string): PlanBlock[] {
  return parseBlocks(markdown.replace(/\r\n?/g, '\n').split('\n'), { slugCounts: new Map() }, 0);
}
