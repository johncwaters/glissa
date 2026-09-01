// Single source of truth for which Alt+<key> combos are Focus-view dashboard shortcuts (dispatched by
// the document keydown handler in app.js). The xterm key handler (terminal.js) consults this so it can
// let exactly these bubble up to the chrome instead of writing an escape sequence to the PTY, which is
// what makes the shortcuts work while the centered terminal holds keyboard focus. Pure, no DOM.
//
// Keep this in lockstep with the dispatch in app.js:
//   W                 -> next session needing you (focusNextAttention)
//   M                 -> merge the review-sidebar selection (mergeSelectedSession)
//   R                 -> resolve a parked merge in its session, else resync its base branch
//                        (resolveSelectedSession, falling back to resyncSelectedSession)
//   ArrowUp/ArrowDown -> previous/next rail session (focusAdjacentInRail)
//   0                 -> open Add Session
//   1-9               -> focus the Nth rail pill (focusNthInRail)
export function isFocusAltShortcut(key: string) {
  if (key === 'w' || key === 'W') return true;
  if (key === 'm' || key === 'M') return true;
  if (key === 'r' || key === 'R') return true;
  if (key === 'ArrowUp' || key === 'ArrowDown') return true;
  return key.length === 1 && key >= '0' && key <= '9';
}
