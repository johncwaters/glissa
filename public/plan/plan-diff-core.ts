export type PlanDiffLineKind = 'added' | 'removed' | 'unchanged' | 'skipped';

export interface PlanDiffLine {
  kind: PlanDiffLineKind;
  text: string;
}

export interface PlanDiff {
  lines: PlanDiffLine[];
  isTooLarge: boolean;
}

export const PLAN_DIFF_MAX_LINES = 2000;
export const PLAN_DIFF_CONTEXT_LINES = 3;

function planLines(body: string): string[] {
  return body.replace(/\r\n?/g, '\n').split('\n');
}

function unchangedLine(text: string): PlanDiffLine {
  return { kind: 'unchanged', text };
}

function skippedLine(lineCount: number): PlanDiffLine {
  return { kind: 'skipped', text: `${lineCount} unchanged lines` };
}

function collapsedRun<Item>(run: readonly Item[], toLine: (item: Item) => PlanDiffLine): PlanDiffLine[] {
  if (run.length <= (PLAN_DIFF_CONTEXT_LINES * 2) + 1) return run.map(toLine);
  return [
    ...run.slice(0, PLAN_DIFF_CONTEXT_LINES).map(toLine),
    skippedLine(run.length - (PLAN_DIFF_CONTEXT_LINES * 2)),
    ...run.slice(run.length - PLAN_DIFF_CONTEXT_LINES).map(toLine),
  ];
}

function itself(line: PlanDiffLine): PlanDiffLine {
  return line;
}

function withUnchangedRunsCollapsed(lines: readonly PlanDiffLine[]): PlanDiffLine[] {
  const collapsed: PlanDiffLine[] = [];
  let at = 0;
  while (at < lines.length) {
    if (lines[at].kind !== 'unchanged') {
      collapsed.push(lines[at]);
      at++;
      continue;
    }
    let runEnd = at;
    while (runEnd < lines.length && lines[runEnd].kind === 'unchanged') runEnd++;
    collapsed.push(...collapsedRun(lines.slice(at, runEnd), itself));
    at = runEnd;
  }
  return collapsed;
}

function commonPrefixLength(before: readonly string[], after: readonly string[]): number {
  const shortest = Math.min(before.length, after.length);
  let matched = 0;
  while (matched < shortest && before[matched] === after[matched]) matched++;
  return matched;
}

function commonSuffixLength(before: readonly string[], after: readonly string[], prefix: number): number {
  const shortest = Math.min(before.length, after.length) - prefix;
  let matched = 0;
  while (matched < shortest && before[before.length - 1 - matched] === after[after.length - 1 - matched]) matched++;
  return matched;
}

function diffChangedLines(before: readonly string[], after: readonly string[]): PlanDiffLine[] {
  const rows = before.length;
  const columns = after.length;
  if (rows === 0) return after.map((text) => ({ kind: 'added', text }));
  if (columns === 0) return before.map((text) => ({ kind: 'removed', text }));

  const width = columns + 1;
  const commonLengths = new Int32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      const at = (row * width) + column;
      if (before[row] === after[column]) {
        commonLengths[at] = commonLengths[at + width + 1] + 1;
        continue;
      }
      commonLengths[at] = Math.max(commonLengths[at + width], commonLengths[at + 1]);
    }
  }

  const lines: PlanDiffLine[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      lines.push(unchangedLine(before[row]));
      row++;
      column++;
      continue;
    }
    if (commonLengths[((row + 1) * width) + column] >= commonLengths[(row * width) + column + 1]) {
      lines.push({ kind: 'removed', text: before[row] });
      row++;
      continue;
    }
    lines.push({ kind: 'added', text: after[column] });
    column++;
  }
  while (row < rows) {
    lines.push({ kind: 'removed', text: before[row] });
    row++;
  }
  while (column < columns) {
    lines.push({ kind: 'added', text: after[column] });
    column++;
  }
  return lines;
}

export function diffPlanBodies(before: string, after: string): PlanDiff {
  const beforeLines = planLines(before);
  const afterLines = planLines(after);
  const prefix = commonPrefixLength(beforeLines, afterLines);
  const suffix = commonSuffixLength(beforeLines, afterLines, prefix);
  const beforeChanged = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterChanged = afterLines.slice(prefix, afterLines.length - suffix);
  if (beforeChanged.length + afterChanged.length > PLAN_DIFF_MAX_LINES) {
    return { lines: [], isTooLarge: true };
  }

  const lines = [
    ...collapsedRun(beforeLines.slice(0, prefix), unchangedLine),
    ...diffChangedLines(beforeChanged, afterChanged),
    ...collapsedRun(beforeLines.slice(beforeLines.length - suffix), unchangedLine),
  ];
  return { lines: withUnchangedRunsCollapsed(lines), isTooLarge: false };
}
