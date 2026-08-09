// Pure form-factor decision: which of the dashboard's two FIRST-CLASS layouts this browser gets.
// Glissa does not have one responsive shell that squeezes; it has a desktop IA (roster rail + centered
// terminal + docked review sidebar) and a phone IA (four screens behind a bottom nav), and this
// function is the single place that says which one is running.
//
// The rule is AND, deliberately, and the pointer half is what makes it honest:
//   - A desktop window dragged down to 500px is still driven by a mouse and a full keyboard, and the
//     operator can widen it again in one gesture. Handing it the phone IA would take away the docked
//     sidebar it can perfectly well afford. It stays 'desktop'.
//   - A phone is coarse AND cannot be widened, so it gets 'phone'.
//   - A coarse-pointer tablet ABOVE the width threshold also stays 'desktop': it has room for all three
//     desktop panels, and the touch corrections in the stylesheet (44px tap targets, hover-free
//     affordances) are keyed on the pointer alone, so it is already served correctly there.
// Everything the phone layout styles keys off the resulting [data-layout="phone"] attribute, so there
// is exactly one predicate to change if the threshold ever moves.

// The narrow half of the rule. 768px is the conventional tablet-portrait boundary and matches the
// width below which the rail + resizer + sidebar minimums (567px) leave no terminal column at all.
export const PHONE_MAX_WIDTH_PX = 768;

export const PHONE_NARROW_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

// decideLayout({ coarse, narrowWidth }) -> 'phone' | 'desktop'. Both inputs are booleans read from
// matchMedia by the shell; an absent or non-boolean input reads as false, so an engine without
// matchMedia lands on 'desktop' rather than guessing.
export function decideLayout({ coarse, narrowWidth } = {}) {
  if (coarse === true && narrowWidth === true) return 'phone';
  return 'desktop';
}
