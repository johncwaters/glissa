// Lever B: a fixed, deterministic anti-slop note appended to a session's system prompt
// via `--append-system-prompt` when antiSlopPrompt is enabled. This REDUCES slop at the
// source (the agent produces less) rather than flagging it after the turn. Code-focused.
//
// House style: no literal em/en dash, no emoji. Kept compact and on one joined line so it
// survives the cmd.exe shim spawn path (see sessions.js buildSpawnCommand fallback).

// No double-quote characters in this string: it is passed as one argv element through the
// cmd.exe /c shim fallback (sessions.js buildSpawnCommand), where embedded quotes get
// mangled by cmd's re-parse. Examples are hyphenated instead of quoted.
const ANTI_SLOP_NOTE = [
  'Code hygiene for this session:',
  'Write comments only to explain why, never narration that restates the code (no Now-we, This-function, or Step-1 openers).',
  'Do not leave debug statements (console.log, print, debugger) in committed code.',
  'Never swallow exceptions: no empty catch blocks and no catch that only logs and continues.',
  'No placeholder stubs or in-a-real-implementation hand-waving; implement the real thing or stop and ask.',
  'Do not silence type or lint errors with as-any, ts-ignore, or eslint-disable; fix the cause.',
  'Avoid speculative wrappers and single-use indirection. Prefer deleting code over adding it.',
].join(' ');

// Spawn args for the note, or [] when disabled. Pushed before the initial-prompt
// positional so the prompt stays the final argv element.
function buildAntiSlopArgs(enabled?: boolean): string[] {
  return enabled ? ['--append-system-prompt', ANTI_SLOP_NOTE] : [];
}

export { ANTI_SLOP_NOTE, buildAntiSlopArgs };
