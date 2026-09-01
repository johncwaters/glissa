function buildTitleSequence(title: string): string {
  return `\x1b]0;${title}\x07`;
}

function buildTitleClearSequence(): string {
  return buildTitleSequence('');
}

export { buildTitleSequence, buildTitleClearSequence };
