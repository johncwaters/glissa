const ANTI_SLOP_NOTE = [
  'Code hygiene for this session:',
  'Write comments only to explain why, never narration that restates the code (no Now-we, This-function, or Step-1 openers).',
  'Do not leave debug statements (console.log, print, debugger) in committed code.',
  'Never swallow exceptions: no empty catch blocks and no catch that only logs and continues.',
  'No placeholder stubs or in-a-real-implementation hand-waving; implement the real thing or stop and ask.',
  'Do not silence type or lint errors with as-any, ts-ignore, or eslint-disable; fix the cause.',
  'Avoid speculative wrappers and single-use indirection. Prefer deleting code over adding it.',
].join(' ');

function buildAntiSlopArgs(enabled?: boolean): string[] {
  return enabled ? ['--append-system-prompt', ANTI_SLOP_NOTE] : [];
}

export { ANTI_SLOP_NOTE, buildAntiSlopArgs };
